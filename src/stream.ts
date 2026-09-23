// Translating Claude Code's SDK message stream into pi's assistant event stream.
//
// Lifecycle, and why it's shaped this way:
//   1. The provider starts a query() and hands the generator to consumeQuery().
//   2. consumeQuery iterates, pushing events onto the current pi stream.
//   3. On a tool call it ends the pi stream and nulls it out. The MCP handler then blocks
//      the generator naturally — no further SDK events arrive until pi delivers a result.
//   4. Pi executes the tool and calls the provider again. The provider swaps in the new
//      stream and resolves the handler; the generator unblocks and events flow onward.
//
// resetTurnState clears turnSawStreamEvent while the generator may still hold queued
// messages from the previous turn. That's safe because step 3 nulls currentPiStream, so
// leftovers hit the `!currentPiStream` guard and are skipped before the reset lands.

import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { calculateCost, type AssistantMessageEventStream, type JsonObject, type StopReason } from "@earendil-works/pi-ai";
import { debug } from "./debug.js";
import { claudeCodeMaxOutputTokens } from "./models.js";
import type { QueryContext, StreamingBlock } from "./query-state.js";
import { notify } from "./runtime.js";
import { mapToolArgs, mapToolName } from "./tool-bridge.js";
import type { BridgeModel } from "./types.js";

// --- Stream lifecycle bookkeeping ---

/** Streams that already received a terminal event, so a second one can be caught. */
const completedStreams = new WeakSet<object>();

export function markStreamComplete(stream: AssistantMessageEventStream | null): void {
	if (stream) completedStreams.add(stream);
}

export function claimCurrentPiStream(
	stream: AssistantMessageEventStream,
	label: string,
	c: QueryContext,
): void {
	if (c.currentPiStream && !completedStreams.has(c.currentPiStream)) {
		debug(`WARNING: currentPiStream overwritten before terminal event (${label}); activeQuery=${Boolean(c.activeQuery)} pendingHandlers=${c.pendingToolCalls.size}`);
	}
	c.currentPiStream = stream;
}

export function ensureTurnStarted(c: QueryContext): void {
	if (c.turnStarted) return;
	const { currentPiStream, turnOutput } = c;
	if (!currentPiStream || !turnOutput) return;
	currentPiStream.push({ type: "start", partial: turnOutput });
	c.turnStarted = true;
}

export function finalizeCurrentStream(c: QueryContext, stopReason?: StopReason): void {
	const { currentPiStream: stream, turnOutput } = c;
	if (!stream || !turnOutput) return;
	debug(`provider: finalizeCurrentStream stopReason=${stopReason} turnOutput=${JSON.stringify({ stopReason: turnOutput.stopReason, error: turnOutput.errorMessage })}`);
	ensureTurnStarted(c);
	stream.push({ type: "done", reason: stopReason === "length" ? "length" : "stop", message: turnOutput });
	markStreamComplete(stream);
	stream.end();
	c.currentPiStream = null;
}

/** End the current stream because a tool call needs pi to run it. */
function endStreamForToolUse(c: QueryContext): void {
	const { currentPiStream: stream, turnOutput } = c;
	if (!stream || !turnOutput) return;
	turnOutput.stopReason = "toolUse";
	stream.push({ type: "done", reason: "toolUse", message: turnOutput });
	markStreamComplete(stream);
	stream.end();
	c.currentPiStream = null;
}

// --- Usage ---

interface RawUsage {
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_read_input_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
	reasoning_tokens?: number | null;
	thinking_tokens?: number | null;
}

const PI_DEFAULT_COMPACTION_RESERVE = 16_384;

/**
 * Preserve exact usage until Claude Code no longer has room for its configured maximum
 * output. At that boundary, report enough pressure to cross Pi's default compaction
 * threshold. Claude Code owns max-output selection and can reject the next internal tool
 * turn even though Pi's much smaller fixed reserve says the transcript still fits.
 */
function contextTokensForPi(actualTokens: number, model: BridgeModel): number {
	const outputHeadroom = claudeCodeMaxOutputTokens(model);
	if (actualTokens < model.contextWindow - outputHeadroom) return actualTokens;
	return Math.max(actualTokens, model.contextWindow - PI_DEFAULT_COMPACTION_RESERVE + 1);
}

export function updateUsage(
	output: { usage: NonNullable<QueryContext["turnOutput"]>["usage"] },
	usage: RawUsage,
	model: BridgeModel,
): void {
	if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
	if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
	if (usage.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
	if (usage.cache_creation_input_tokens != null) output.usage.cacheWrite = usage.cache_creation_input_tokens;

	const reasoning = usage.reasoning_tokens ?? usage.thinking_tokens;
	if (reasoning != null) output.usage.reasoning = reasoning;

	const actualTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
	output.usage.totalTokens = contextTokensForPi(actualTokens, model);
	calculateCost(model, output.usage);

	const promptTokens = output.usage.input + output.usage.cacheRead + output.usage.cacheWrite;
	const cachePct = promptTokens > 0 ? Math.round(output.usage.cacheRead / promptTokens * 100) : 0;
	const pressure = output.usage.totalTokens === actualTokens ? "" : ` actual=${actualTokens}`;
	debug(`usage: in=${output.usage.input} out=${output.usage.output} cacheRead=${output.usage.cacheRead} cacheWrite=${output.usage.cacheWrite} total=${output.usage.totalTokens}${pressure}${reasoning != null ? ` reasoning=${reasoning}` : ""} cachePct=${cachePct}% model=${model.id}`);
}

/**
 * Log the context window Claude Code actually served.
 *
 * This can differ from the window pi registered when the runtime entitlement doesn't
 * match the documented policy — bare Opus served 200K on Pro, or a `[1m]` suffix not
 * honoured. The result message's modelUsage is otherwise discarded, so without this the
 * gap is invisible.
 */
export function logServedContextWindow(label: string, message: SDKMessage, model: BridgeModel): void {
	if (message.type !== "result") return;
	for (const [servedModel, usage] of Object.entries(message.modelUsage ?? {})) {
		debug(`${label}: served contextWindow=${usage.contextWindow ?? "?"} maxOutputTokens=${usage.maxOutputTokens ?? "?"} servedModel=${servedModel} registered=${model.contextWindow}`);
	}
}

// --- Event translation ---

function mapStopReason(reason: string | null | undefined): "stop" | "length" | "toolUse" {
	switch (reason) {
		case "tool_use": return "toolUse";
		case "max_tokens": return "length";
		default: return "stop";
	}
}

function parsePartialJson(input: string, fallback: JsonObject): JsonObject {
	if (!input) return fallback;
	try {
		const parsed: unknown = JSON.parse(input);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as JsonObject : fallback;
	} catch {
		return fallback;
	}
}

function findBlockByIndex(blocks: StreamingBlock[], index: number): { block: StreamingBlock; at: number } | undefined {
	const at = blocks.findIndex((b) => b.index === index);
	const block = at === -1 ? undefined : blocks[at];
	return block ? { block, at } : undefined;
}

/**
 * Map one Anthropic stream event onto pi stream events.
 * On message_stop following a tool call, ends the pi stream so pi can execute the tool.
 */
export function processStreamEvent(
	event: Extract<SDKMessage, { type: "stream_event" }>["event"],
	customToolNameToPi: Map<string, string>,
	model: BridgeModel,
	c: QueryContext,
): void {
	const stream = c.currentPiStream;
	const turnOutput = c.turnOutput;
	if (!stream || !turnOutput) return;
	c.turnSawStreamEvent = true;

	// The switch below is exhaustive over today's event union, so `event.type` narrows to
	// never in the default arm. Captured up front so the forward-compat log still compiles
	// when the SDK adds an event type.
	const eventType: string = event.type;

	switch (event.type) {
		case "message_start": {
			c.turnToolCallIds = [];
			c.nextHandlerIdx = 0;
			if (event.message.usage) updateUsage(turnOutput, event.message.usage as RawUsage, model);
			return;
		}

		case "content_block_start": {
			ensureTurnStarted(c);
			const block = event.content_block;
			if (block.type === "text") {
				c.turnBlocks.push({ type: "text", text: "", index: event.index });
				stream.push({ type: "text_start", contentIndex: c.turnBlocks.length - 1, partial: turnOutput });
			} else if (block.type === "thinking") {
				c.turnBlocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index });
				stream.push({ type: "thinking_start", contentIndex: c.turnBlocks.length - 1, partial: turnOutput });
			} else if (block.type === "tool_use") {
				c.turnSawToolCall = true;
				c.turnToolCallIds.push(block.id);
				c.turnBlocks.push({
					type: "toolCall",
					id: block.id,
					name: mapToolName(block.name, customToolNameToPi),
					arguments: (block.input as JsonObject) ?? {},
					partialJson: "",
					index: event.index,
				});
				stream.push({ type: "toolcall_start", contentIndex: c.turnBlocks.length - 1, partial: turnOutput });
			} else {
				debug("processStreamEvent: unhandled content_block_start type", block.type);
			}
			return;
		}

		case "content_block_delta": {
			const found = findBlockByIndex(c.turnBlocks, event.index);
			if (!found) return;
			const { block, at } = found;
			const delta = event.delta;
			if (delta.type === "text_delta" && block.type === "text") {
				block.text += delta.text;
				stream.push({ type: "text_delta", contentIndex: at, delta: delta.text, partial: turnOutput });
			} else if (delta.type === "thinking_delta" && block.type === "thinking") {
				block.thinking += delta.thinking;
				stream.push({ type: "thinking_delta", contentIndex: at, delta: delta.thinking, partial: turnOutput });
			} else if (delta.type === "input_json_delta" && block.type === "toolCall") {
				block.partialJson = (block.partialJson ?? "") + delta.partial_json;
				block.arguments = parsePartialJson(block.partialJson, block.arguments);
				stream.push({ type: "toolcall_delta", contentIndex: at, delta: delta.partial_json, partial: turnOutput });
			} else if (delta.type === "signature_delta" && block.type === "thinking") {
				block.thinkingSignature = (block.thinkingSignature ?? "") + delta.signature;
			} else {
				debug("processStreamEvent: unhandled content_block_delta type", delta.type);
			}
			return;
		}

		case "content_block_stop": {
			const found = findBlockByIndex(c.turnBlocks, event.index);
			if (!found) return;
			const { block, at } = found;
			delete block.index;
			if (block.type === "text") {
				stream.push({ type: "text_end", contentIndex: at, content: block.text, partial: turnOutput });
			} else if (block.type === "thinking") {
				stream.push({ type: "thinking_end", contentIndex: at, content: block.thinking, partial: turnOutput });
			} else if (block.type === "toolCall") {
				c.turnSawToolCall = true;
				block.arguments = mapToolArgs(block.name, parsePartialJson(block.partialJson ?? "", block.arguments));
				delete block.partialJson;
				stream.push({ type: "toolcall_end", contentIndex: at, toolCall: block, partial: turnOutput });
			}
			return;
		}

		case "message_delta": {
			turnOutput.stopReason = mapStopReason(event.delta.stop_reason);
			if (event.usage) updateUsage(turnOutput, event.usage as RawUsage, model);
			return;
		}

		case "message_stop": {
			if (!c.turnSawToolCall) return;
			// The SDK will still yield an assistant message for this turn, but nulling
			// currentPiStream makes consumeQuery skip it. The MCP handler holds the
			// generator until pi delivers the tool result.
			//
			// The cursor is advanced by the next streamSimple call (the tool-result
			// delivery path), which sets it from the post-result context length.
			endStreamForToolUse(c);
			return;
		}

		default:
			debug("processStreamEvent: unhandled event type", eventType);
	}
}

/**
 * Fallback path for turns that arrive as a whole assistant message rather than deltas.
 *
 * The SDK always yields a completed `assistant` message after streaming. When
 * stream_events already delivered the content this is a no-op, but after resetTurnState
 * (e.g. tool-result delivery) the next turn's assistant message can arrive before any
 * stream event, making this the primary content path. It must maintain the same stream
 * lifecycle as processStreamEvent — including ending the stream on tool_use, or the MCP
 * handler deadlocks.
 */
export function processAssistantMessage(
	message: Extract<SDKMessage, { type: "assistant" }>,
	model: BridgeModel,
	customToolNameToPi: Map<string, string>,
	c: QueryContext,
): void {
	if (c.turnSawStreamEvent) return;
	const content = message.message.content;
	if (!content) return;
	const turnOutput = c.turnOutput;
	if (!turnOutput) return;

	c.turnToolCallIds = [];
	c.nextHandlerIdx = 0;
	debug(`processAssistantMessage fallback: ${content.length} blocks, types=${content.map((b) => b.type).join(",")}`);

	for (const block of content) {
		const stream = c.currentPiStream;
		// Captured before narrowing so the exhaustive-else log still compiles if the SDK
		// adds block types we don't handle.
		const blockType: string = block.type;
		if (block.type === "text" && block.text) {
			ensureTurnStarted(c);
			c.turnBlocks.push({ type: "text", text: block.text });
			const idx = c.turnBlocks.length - 1;
			stream?.push({ type: "text_start", contentIndex: idx, partial: turnOutput });
			stream?.push({ type: "text_delta", contentIndex: idx, delta: block.text, partial: turnOutput });
			stream?.push({ type: "text_end", contentIndex: idx, content: block.text, partial: turnOutput });
		} else if (block.type === "thinking") {
			ensureTurnStarted(c);
			c.turnBlocks.push({ type: "thinking", thinking: block.thinking ?? "", thinkingSignature: block.signature ?? "" });
			const idx = c.turnBlocks.length - 1;
			stream?.push({ type: "thinking_start", contentIndex: idx, partial: turnOutput });
			if (block.thinking) stream?.push({ type: "thinking_delta", contentIndex: idx, delta: block.thinking, partial: turnOutput });
			stream?.push({ type: "thinking_end", contentIndex: idx, content: block.thinking ?? "", partial: turnOutput });
		} else if (block.type === "tool_use") {
			ensureTurnStarted(c);
			c.turnSawToolCall = true;
			c.turnToolCallIds.push(block.id);
			const name = mapToolName(block.name, customToolNameToPi);
			c.turnBlocks.push({
				type: "toolCall",
				id: block.id,
				name,
				arguments: mapToolArgs(name, block.input as JsonObject),
			});
			const idx = c.turnBlocks.length - 1;
			const toolBlock = c.turnBlocks[idx];
			stream?.push({ type: "toolcall_start", contentIndex: idx, partial: turnOutput });
			if (toolBlock && toolBlock.type === "toolCall") {
				stream?.push({ type: "toolcall_end", contentIndex: idx, toolCall: toolBlock, partial: turnOutput });
			}
		} else {
			debug("processAssistantMessage: unhandled block type", blockType);
		}
	}

	if (message.message.usage) updateUsage(turnOutput, message.message.usage as RawUsage, model);

	if (c.turnSawToolCall) endStreamForToolUse(c);
}

function reportRateLimit(info: { status?: string; resetsAt?: number; rateLimitType?: string; utilization?: number }): void {
	debug("consumeQuery: rate_limit_event", JSON.stringify(info).slice(0, 300));
	if (info.status === "rejected") {
		const resetsAt = info.resetsAt ? new Date(info.resetsAt).toLocaleTimeString() : "unknown";
		notify(`Claude rate limited (${info.rateLimitType ?? "unknown"}) — resets at ${resetsAt}`, "warning");
	} else if (info.status === "allowed_warning") {
		notify(`Claude rate limit warning: ${Math.round(info.utilization ?? 0)}% used (${info.rateLimitType ?? ""})`, "warning");
	}
}

/**
 * Background consumer: drains the SDK generator into the current pi stream until the
 * query ends. Per turn the SDK yields stream_events (deltas) then a completed assistant
 * message; whichever path sees the tool call first ends the stream, and the MCP handler
 * blocks the generator until pi delivers the result.
 */
export async function consumeQuery(
	sdkQuery: Query,
	customToolNameToPi: Map<string, string>,
	model: BridgeModel,
	wasAborted: () => boolean,
	queryCtx: QueryContext,
): Promise<{ capturedSessionId?: string }> {
	let capturedSessionId: string | undefined;

	for await (const message of sdkQuery) {
		if (wasAborted()) break;
		if (!queryCtx.currentPiStream || !queryCtx.turnOutput) continue;

		switch (message.type) {
			case "stream_event":
				processStreamEvent(message.event, customToolNameToPi, model, queryCtx);
				break;

			case "assistant":
				processAssistantMessage(message, model, customToolNameToPi, queryCtx);
				break;

			case "result": {
				logServedContextWindow("result", message, model);
				// No stream events at all means the turn arrived only as a final result
				// (e.g. a cached or trivially short reply). Synthesise the text block.
				if (!queryCtx.turnSawStreamEvent && message.subtype === "success") {
					ensureTurnStarted(queryCtx);
					const text = message.result || "";
					queryCtx.turnBlocks.push({ type: "text", text });
					const idx = queryCtx.turnBlocks.length - 1;
					const stream = queryCtx.currentPiStream;
					stream?.push({ type: "text_start", contentIndex: idx, partial: queryCtx.turnOutput });
					stream?.push({ type: "text_delta", contentIndex: idx, delta: text, partial: queryCtx.turnOutput });
					stream?.push({ type: "text_end", contentIndex: idx, content: text, partial: queryCtx.turnOutput });
				}
				break;
			}

			case "system":
				if (message.subtype === "init" && message.session_id) capturedSessionId = message.session_id;
				break;

			case "user":
				break; // SDK echo of our own prompt

			case "rate_limit_event":
				reportRateLimit(message.rate_limit_info);
				break;

			default:
				debug("consumeQuery: unhandled SDK message type", message.type);
				break;
		}
	}

	debug(`consumeQuery: loop exited, wasAborted=${wasAborted()}, capturedSessionId=${capturedSessionId?.slice(0, 8) ?? "none"}`);
	return { capturedSessionId };
}
