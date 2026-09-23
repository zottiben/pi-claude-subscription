// The pi provider: every turn on a claude-subscription model runs through here.
//
// Pi calls streamClaudeAgentSdk once per prompt and once per tool result, so a single
// logical Claude Code query spans many calls. The three cases it dispatches between:
//
//   tool result delivery — an active query is waiting on MCP handlers; resolve them and
//                          return an empty stream (the real events resume on the handler's
//                          stream, already claimed here).
//   orphaned tool result — the query is gone (aborted) but pi still delivered a result;
//                          emit end_turn so pi stops waiting.
//   fresh query          — start a new Claude Code query.

import {
	query,
	type EffortLevel,
	type Options as SdkOptions,
	type SDKMessage,
	type SDKUserMessage,
	type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import type { Base64ImageSource, ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources";
import {
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	withoutInitialSystemMessage,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type SimpleStreamOptions,
	type StopReason,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { CompactionEntry } from "@earendil-works/pi-coding-agent";
import { debug, diagDump, errorMessage, makeCliDebugOptions } from "./debug.js";
import { extractAgentsAppend } from "./agents-md.js";
import { extractAllToolResults as extractAllToolResultsPure, type McpResult } from "./extract-tool-results.js";
import { claudeCodeModelId } from "./models.js";
import { ctx, QueryContext, resetContext } from "./query-state.js";
import { getLongContextSettings, getProviderSettings, notify } from "./runtime.js";
import {
	discardEphemeralSession,
	getSharedSession,
	markNeedsRebuild,
	setSharedSession,
	setSharedSessionCursor,
	syncSharedSession,
} from "./session-sync.js";
import { extractSkillsBlock } from "./skills.js";
import {
	claimCurrentPiStream,
	consumeQuery,
	finalizeCurrentStream,
	logServedContextWindow,
	markStreamComplete,
} from "./stream.js";
import { buildMcpServers, resolveMcpTools } from "./tool-bridge.js";
import type { BridgeModel } from "./types.js";
import { messageContentToText } from "./convert.js";

/** Pi reasoning levels mapped onto Claude Code SDK effort levels. */
export const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
	minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max",
};

/** Contexts for queries currently in flight, including reentrant subagent queries. */
const activeQueryContexts = new Set<QueryContext>();

/** Name of the AskClaude tool, so the provider can exclude it from the MCP bridge and avoid
 *  offering Claude Code a tool that delegates straight back to Claude Code. Overwritten at
 *  activation by setAskClaudeToolName with the configured name; the initial value only
 *  matters if a turn somehow runs before registration. */
let askClaudeToolName = "";

export function setAskClaudeToolName(name: string): void {
	askClaudeToolName = name;
}

/**
 * Rotate the top-level Claude Code query before Pi installs a compaction boundary.
 *
 * A query spans Pi's tool-result turns, so compacting only Pi's transcript leaves the
 * subprocess on the old, oversized history. Waiting for the old consumer to settle keeps
 * it from racing the replacement query's stream or shared-session state. Reentrant
 * subagent contexts are independent and must not be cancelled with the parent.
 */
export async function prepareForCompactionContinuation(willRetry: boolean): Promise<void> {
	const topLevel = ctx();
	let interrupted = false;
	if (topLevel.activeQuery) {
		interrupted = true;
		if (topLevel.abortActiveQuery) topLevel.abortActiveQuery();
		else {
			try { topLevel.activeQuery.close(); } catch { /* already closed */ }
			topLevel.activeQuery = null;
		}
		if (topLevel.activeQueryCompletion) await Promise.allSettled([topLevel.activeQueryCompletion]);
	}

	if (!willRetry && !interrupted) return;
	const replacement = resetContext();
	replacement.resumeAfterCompaction = true;
	debug(`compaction continuation prepared: willRetry=${willRetry} interrupted=${interrupted}`);
}

/** Consume the one-shot continuation marker installed around compaction. */
export function consumeCompactionContinuation(): boolean {
	const queryCtx = ctx();
	if (!queryCtx.resumeAfterCompaction) return false;
	queryCtx.resumeAfterCompaction = false;
	return true;
}

// --- Small helpers ---

function newAssistantOutput(
	model: BridgeModel,
	text: string,
	stopReason: StopReason,
	errorText?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		...(errorText ? { errorMessage: errorText } : {}),
		timestamp: Date.now(),
	};
}

/** Thin wrapper over the pure extractor, adding per-turn logging at the boundary. */
function extractAllToolResults(context: TranscriptContext): McpResult[] {
	const { results, stopIdx } = extractAllToolResultsPure(context.messages);
	debug(`extractAllToolResults: ${results.length} results from ${context.messages.length} msgs, stopped at index ${stopIdx}`);
	debug("extractAllToolResults: all msg roles:", context.messages.map((m, i) => `[${i}]${m.role}`).join(" "));
	results.forEach((r, i) => {
		debug(`extractAllToolResults: result[${i}] id=${r.toolCallId}${r.isError ? " ERROR" : ""} preview:`, JSON.stringify(r.content).slice(0, 150));
	});
	return results;
}

/** Last user message as plain text, or null when the last message isn't from the user. */
function extractUserPrompt(messages: TranscriptContext["messages"]): string | null {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "user") return null;
	if (typeof last.content === "string") return last.content;
	return messageContentToText(last.content) || "";
}

/**
 * Last user message as content blocks, preserving images.
 * Returns null when there are no images — callers fall back to the plain string prompt,
 * which keeps the common path on the cheaper string form.
 */
function extractUserPromptBlocks(messages: TranscriptContext["messages"]): ContentBlockParam[] | null {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "user") return null;
	if (typeof last.content === "string") {
		debug(`extractUserPromptBlocks: content is string (length=${last.content.length})`);
		return null;
	}
	if (!Array.isArray(last.content)) return null;

	debug(`extractUserPromptBlocks: ${last.content.length} blocks, types=${last.content.map((b) => b.type).join(",")}`);
	let hasImage = false;
	const blocks: ContentBlockParam[] = [];
	for (const block of last.content) {
		if (block.type === "text" && block.text) {
			blocks.push({ type: "text", text: block.text });
		} else if (block.type === "image") {
			if (!block.data || !block.mimeType) {
				debug("extractUserPromptBlocks: image block missing data or mimeType, skipping");
				continue;
			}
			hasImage = true;
			blocks.push({
				type: "image",
				source: { type: "base64", media_type: block.mimeType as Base64ImageSource["media_type"], data: block.data },
			});
		}
	}
	return hasImage ? blocks : null;
}

async function* wrapPromptStream(blocks: ContentBlockParam[]): AsyncIterable<SDKUserMessage> {
	yield {
		type: "user",
		message: { role: "user", content: blocks } as MessageParam,
		parent_tool_use_id: null,
	} as SDKUserMessage;
}

/**
 * End a stream with a terminal error event.
 *
 * Always pushes something before ending: pi resolves a stream's result from its terminal
 * event, so a stream that is ended without one leaves the turn hanging forever. If the
 * turn output is somehow missing, synthesise one rather than ending empty.
 */
function terminateStreamWithError(
	queryCtx: QueryContext,
	model: BridgeModel,
	reason: "aborted" | "error",
	message: string,
): void {
	const stream = queryCtx.currentPiStream;
	const output = queryCtx.turnOutput ?? newAssistantOutput(model, "", reason, message);
	output.stopReason = reason;
	output.errorMessage = message;
	stream?.push({ type: "error", reason, error: output });
	markStreamComplete(stream);
	stream?.end();
	queryCtx.currentPiStream = null;
}

function contextForToolResults(results: readonly McpResult[]): QueryContext | undefined {
	for (const result of results) {
		const id = result.toolCallId;
		if (!id) continue;
		for (const queryCtx of activeQueryContexts) {
			if (queryCtx.pendingToolCalls.has(id) || queryCtx.pendingResults.has(id) || queryCtx.turnToolCallIds.includes(id)) {
				return queryCtx;
			}
		}
	}
	return undefined;
}

// --- Compaction takeover ---
//
// Pi's built-in compaction would summarise through its own provider path. Claude Code
// models can't be driven that way, so the extension takes the summarisation over with a
// one-shot, tool-less, non-persisted query.

export function extractIsolatedSummaryPrompt(messages: TranscriptContext["messages"]): string {
	// Pi normalises the summarization system prompt into a leading system message rather
	// than a separate field, so the transcript arrives as [system, user]. That prompt is
	// replayed separately by runIsolatedSummary; here we want only the conversation turn.
	const conversation = withoutInitialSystemMessage(messages);
	if (conversation.length !== 1 || conversation[0]?.role !== "user") {
		throw new Error(
			`isolatedStreamFn: expected exactly 1 user message, got ${conversation.length} ` +
			`(${conversation.map((m) => m.role).join(",")})`,
		);
	}
	const promptText = extractUserPrompt(conversation);
	if (!promptText) throw new Error("isolatedStreamFn: summarization prompt is empty");
	return promptText;
}

function resultErrorText(message: Extract<SDKMessage, { type: "result" }>): string {
	if (message.subtype !== "success" && Array.isArray(message.errors)) {
		return message.errors.map(String).join("\n");
	}
	return `Claude Code summary failed: ${message.subtype}`;
}

export function isolatedStreamFn(
	model: BridgeModel,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void runIsolatedSummary(model, context, options, stream);
	return stream;
}

async function runIsolatedSummary(
	model: BridgeModel,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	let sdkQuery: ReturnType<typeof query> | undefined;
	let wasAborted = false;
	const onAbort = () => {
		wasAborted = true;
		void sdkQuery?.interrupt().catch(() => {});
		try { sdkQuery?.close(); } catch { /* already closed */ }
	};

	try {
		const promptText = extractIsolatedSummaryPrompt(context.messages);
		const cwd = process.cwd();
		const claudeExecutable = getProviderSettings().pathToClaudeCodeExecutable;
		const cliModel = claudeCodeModelId(model, getLongContextSettings());
		debug(`compact summary: spawn model=${cliModel} registeredModel=${model.id} promptLen=${promptText.length}`);

		sdkQuery = query({
			prompt: promptText,
			options: {
				cwd,
				env: { ...process.env, DISABLE_AUTO_COMPACT: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
				tools: [],
				strictMcpConfig: true,
				settingSources: [] as SettingSource[],
				skills: [],
				persistSession: false,
				systemPrompt: getCurrentSystemPrompt(context.messages) || undefined,
				model: cliModel,
				maxTurns: 1,
				...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
				...makeCliDebugOptions("compact-summary"),
			},
		});

		if (options?.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}

		let assistantText = "";
		let finalText = "";
		let errorText: string | undefined;
		let firstEventLogged = false;

		for await (const message of sdkQuery) {
			if (!firstEventLogged) {
				debug(`compact summary: first event type=${message.type}`);
				firstEventLogged = true;
			}
			if (wasAborted) break;

			if (message.type === "assistant") {
				for (const block of message.message.content ?? []) {
					if (block.type === "text" && typeof block.text === "string") assistantText += block.text;
				}
			} else if (message.type === "result") {
				logServedContextWindow("compact summary", message, model);
				if (message.subtype === "success") finalText = message.result || assistantText;
				else errorText = resultErrorText(message);
			}
		}

		if (wasAborted) {
			debug("compact summary: aborted");
			stream.push({ type: "error", reason: "aborted", error: newAssistantOutput(model, "", "aborted", "Operation aborted") });
			stream.end();
			return;
		}

		const text = finalText || assistantText;
		if (errorText || !text.trim()) {
			const msg = errorText ?? "Claude Code summary returned empty text";
			debug(`compact summary: error ${msg}`);
			stream.push({ type: "error", reason: "error", error: newAssistantOutput(model, "", "error", msg) });
			stream.end();
			return;
		}

		debug(`compact summary: done textLen=${text.length}`);
		stream.push({ type: "done", reason: "stop", message: newAssistantOutput(model, text, "stop") });
		stream.end();
	} catch (err) {
		const msg = errorMessage(err);
		debug("runIsolatedSummary threw; pushing terminal error", err);
		stream.push({ type: "error", reason: "error", error: newAssistantOutput(model, "", "error", msg) });
		stream.end();
	} finally {
		options?.signal?.removeEventListener("abort", onAbort);
		try { sdkQuery?.close(); } catch { /* already closed */ }
	}
}

/**
 * Carry file-operation history across successive compactions.
 *
 * Each compaction only sees the messages it is summarising, so without this the list of
 * files read/modified resets every time and the summary loses track of what the session
 * has touched.
 */
export function reinjectPriorCompactionFileOps(
	branchEntries: ReadonlyArray<{ type: string; details?: unknown }>,
	preparation: { fileOps: { read: Set<string>; edited: Set<string> } },
): void {
	const prior = [...branchEntries].reverse().find((entry): entry is CompactionEntry => entry.type === "compaction");
	const details = prior?.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined;
	if (!Array.isArray(details?.readFiles) || !Array.isArray(details.modifiedFiles)) return;
	for (const file of details.readFiles) preparation.fileOps.read.add(String(file));
	for (const file of details.modifiedFiles) preparation.fileOps.edited.add(String(file));
	debug(`compact takeover: re-injected prior file ops read=${details.readFiles.length} modified=${details.modifiedFiles.length}`);
}

// --- Provider entry point ---

export function streamClaudeAgentSdk(
	model: BridgeModel,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	const lastMsgRole = context.messages[context.messages.length - 1]?.role;
	const hasActiveQuery = ctx().activeQuery !== null;
	debug(`provider: streamClaudeAgentSdk called, activeQuery=${hasActiveQuery}, lastMsgRole=${lastMsgRole}`);

	// Overflow recovery and mid-query threshold compaction retain a trailing tool result.
	// The old Claude Code query was deliberately rotated, so rebuild from Pi's compacted
	// transcript and continue instead of classifying that result as orphaned.
	if (consumeCompactionContinuation()) {
		const includeTrailingToolResult = lastMsgRole === "toolResult";
		debug(`provider: rebuilding fresh continuation after compaction, includeTrailingToolResult=${includeTrailingToolResult}`);
		startFreshQuery(stream, model, context, options, false, includeTrailingToolResult);
		return stream;
	}

	const allResults = activeQueryContexts.size > 0 ? extractAllToolResults(context) : [];
	const resultCtx = allResults.length > 0 ? contextForToolResults(allResults) : undefined;

	if (resultCtx) {
		deliverToolResults(stream, model, context, allResults, resultCtx, lastMsgRole);
		return stream;
	}

	// Orphaned tool result: the query is gone (user aborted a tool call) but pi still
	// delivered the result. Emit end_turn so pi waits for the next real user message.
	if (context.messages[context.messages.length - 1]?.role === "toolResult") {
		debug("provider: orphaned tool result after abort, emitting end_turn");
		setSharedSessionCursor(context.messages.length);
		const c = ctx();
		queueMicrotask(() => {
			c.resetTurnState(model);
			stream.push({ type: "done", reason: "stop", message: c.turnOutput! });
			markStreamComplete(stream);
			stream.end();
		});
		return stream;
	}

	startFreshQuery(stream, model, context, options, hasActiveQuery);
	return stream;
}

/**
 * Pi appends tool results to the context and calls the provider again. Match this turn's
 * results against waiting MCP handlers by id; anything that arrives before its handler is
 * parked in pendingResults for the handler to pick up.
 */
function deliverToolResults(
	stream: AssistantMessageEventStream,
	model: BridgeModel,
	context: TranscriptContext,
	allResults: McpResult[],
	resultCtx: QueryContext,
	lastMsgRole: string | undefined,
): void {
	claimCurrentPiStream(stream, "tool-result", resultCtx);
	resultCtx.resetTurnState(model);
	debug(`provider: tool results, ${allResults.length} results, ${resultCtx.pendingToolCalls.size} waiting handlers, ctx.msgs=${context.messages.length}`);

	for (const result of allResults) {
		const id = result.toolCallId;
		if (!id) {
			debug("WARNING: tool result without toolCallId, cannot match");
			continue;
		}
		const pending = resultCtx.pendingToolCalls.get(id);
		if (pending) {
			resultCtx.pendingToolCalls.delete(id);
			debug(`provider: resolving ${pending.toolName} [${id}]${result.isError ? " (error)" : ""}`, JSON.stringify(result.content).slice(0, 200));
			pending.resolve(result);
		} else {
			resultCtx.pendingResults.set(id, result);
			debug(`provider: queued result [${id}] (${resultCtx.pendingResults.size} pending)`);
		}
		if (resultCtx.pendingToolCalls.size > 0 && resultCtx.pendingResults.size > 0) {
			debug(`BUG: both maps non-empty! handlers=${resultCtx.pendingToolCalls.size} results=${resultCtx.pendingResults.size}`);
		}
	}

	if (resultCtx.pendingToolCalls.size > 0) {
		debug(`WARNING: ${resultCtx.pendingToolCalls.size} MCP handlers still waiting after delivering ${allResults.length} results`);
		notify(`claude-subscription: ${resultCtx.pendingToolCalls.size} tool handler(s) still waiting — the provider may be stuck`, "warning");
	}

	// A user message alongside the tool result means pi injected a steer or followUp
	// during the active query: either the user steered while a tool was running and pi
	// drained the queue at the turn boundary, or a followUp landed between tool-result
	// turns. We can't forward those mid-query, so save them for replay as continuation
	// queries once consumeQuery finishes.
	if (lastMsgRole === "user") {
		const userPrompt = extractUserPrompt(context.messages);
		if (userPrompt) {
			resultCtx.deferredUserMessages.push(userPrompt);
			debug(`provider: deferred user message for replay after query: ${userPrompt.slice(0, 60)}`);
		}
	}

	setSharedSessionCursor(context.messages.length);
	resultCtx.latestCursor = Math.max(resultCtx.latestCursor, context.messages.length);
}

function startFreshQuery(
	stream: AssistantMessageEventStream,
	model: BridgeModel,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	isReentrant: boolean,
	includeTrailingToolResult = false,
): void {
	// Reentrant queries get their own QueryContext so a background subagent can run
	// concurrently with the parent without their tool handlers colliding.
	const queryCtx = isReentrant ? new QueryContext() : ctx();
	debug(`provider: fresh query setup, isReentrant=${isReentrant}, activeContexts=${activeQueryContexts.size}`);

	claimCurrentPiStream(stream, "fresh-query", queryCtx);
	queryCtx.pendingToolCalls.clear();
	queryCtx.pendingResults.clear();
	queryCtx.deferredUserMessages = [];
	queryCtx.resetTurnState(model);
	queryCtx.latestCursor = 0;

	const providerSettings = getProviderSettings();
	const { mcpTools, customToolNameToSdk, customToolNameToPi } = resolveMcpTools(context, askClaudeToolName);
	const cwd = process.cwd();
	const syncResult = syncSharedSession(
		context.messages,
		cwd,
		customToolNameToSdk,
		model.id,
		{ includeLastMessage: includeTrailingToolResult },
	);
	const resumeSessionId = syncResult.sessionId;
	const promptBlocks = includeTrailingToolResult ? null : extractUserPromptBlocks(context.messages);
	let promptText = includeTrailingToolResult ? "[continue]" : extractUserPrompt(context.messages) ?? "";

	// An empty prompt means the last context message isn't a user message, which should be
	// unreachable outside an intentional post-compaction continuation. Dump diagnostics,
	// then recover with a marker so the SDK doesn't receive an empty text block.
	if (!promptText && !promptBlocks) {
		diagDump("empty_prompt", {
			contextLength: context.messages.length,
			lastMsgRole: context.messages[context.messages.length - 1]?.role,
			isReentrant,
			activeQueryContexts: activeQueryContexts.size,
			activeQueryExists: queryCtx.activeQuery !== null,
			sharedSession: getSharedSession()
				? { sessionId: getSharedSession()!.sessionId.slice(0, 8), cursor: getSharedSession()!.cursor }
				: null,
			messageRoles: context.messages.map((m, i) => `[${i}]${m.role}`).join(" "),
		});
		promptText = "[continue]";
	}

	const prompt: string | AsyncIterable<SDKUserMessage> = promptBlocks ? wrapPromptStream(promptBlocks) : promptText;
	const mcpServers = buildMcpServers(mcpTools, queryCtx);

	const appendSystemPrompt = providerSettings.appendSystemPrompt !== false;
	const appendParts = appendSystemPrompt
		? [extractAgentsAppend(cwd), extractSkillsBlock(getCurrentSystemPrompt(context.messages))].filter((p): p is string => Boolean(p))
		: [];
	const systemPromptAppend = appendParts.length > 0 ? appendParts.join("\n\n") : undefined;

	// Claude Code reads MCP servers from ~/.claude.json and .mcp.json. Since pi executes
	// tools rather than Claude Code, those are pure token overhead. --strict-mcp-config
	// restricts it to the servers we pass programmatically. Applied unconditionally,
	// because settingSources=undefined does NOT give isolation — the Claude Code default
	// loads every source.
	const settingSources: SettingSource[] | undefined = appendSystemPrompt
		? undefined
		: providerSettings.settingSources ?? ["user", "project"];
	const strictMcpConfigEnabled = providerSettings.strictMcpConfig !== false;

	// Prefer the model's own thinkingLevelMap when pi-ai ships one (0.72+ has per-model
	// overrides — opus-4-7 wants xhigh→xhigh, not xhigh→max); fall back to the generic table.
	const effort = options?.reasoning
		? (model.thinkingLevelMap?.[options.reasoning] as EffortLevel | undefined) ?? REASONING_TO_EFFORT[options.reasoning]
		: undefined;

	// cliModel may carry a [1m] suffix; model.id is what pi registered. Log the former so
	// debug output reflects what Claude Code actually received.
	const cliModel = claudeCodeModelId(model, getLongContextSettings());
	const extraArgs: Record<string, string | null> = { model: cliModel };
	if (strictMcpConfigEnabled) extraArgs["strict-mcp-config"] = null;
	// Opus 4.7 defaults thinking.display to "omitted", which yields empty thinking text in
	// the stream. Force summarized so thinking_delta events actually arrive.
	if (effort) extraArgs["thinking-display"] = "summarized";

	// ENABLE_CLAUDEAI_MCP_SERVERS=0 suppresses claude.ai cloud MCP servers (Figma, Canva,
	// and friends, auto-discovered via OAuth). They're a separate code path from filesystem
	// MCP and are NOT blocked by --strict-mcp-config or settingSources.
	//
	// DISABLE_AUTO_COMPACT=1 because pi owns context management and propagates its own
	// /compact through session_compact. Letting Claude Code also autocompact would
	// double-flush the prompt cache and race pi's threshold against its own anti-thrashing
	// guard. Manual /compact inside Claude Code still works — we never invoke it.
	const childEnv = { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "0", DISABLE_AUTO_COMPACT: "1" };

	const queryOptions: SdkOptions = {
		cwd,
		env: childEnv,
		tools: [],
		permissionMode: "bypassPermissions",
		includePartialMessages: true,
		systemPrompt: { type: "preset", preset: "claude_code", append: systemPromptAppend },
		extraArgs,
		...(effort ? { effort } : {}),
		...(settingSources ? { settingSources } : {}),
		...(mcpServers ? { mcpServers } : {}),
		...(resumeSessionId ? { resume: resumeSessionId } : {}),
		...(providerSettings.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: providerSettings.pathToClaudeCodeExecutable } : {}),
		...makeCliDebugOptions("provider"),
	};

	debug("provider: fresh query",
		`model=${cliModel} msgs=${context.messages.length} tools=${mcpTools.length}`,
		`resume=${resumeSessionId?.slice(0, 8) ?? "none"} effort=${effort ?? "default"}`,
		`appendSys=${appendSystemPrompt} strictMcp=${strictMcpConfigEnabled}`,
		`prompt=${promptText.slice(0, 60)}${promptBlocks ? " [+images]" : ""}`);

	let wasAborted = false;
	const sdkQuery = query({ prompt, options: queryOptions });
	queryCtx.activeQuery = sdkQuery;
	activeQueryContexts.add(queryCtx);

	const onAbort = () => {
		if (wasAborted) return;
		wasAborted = true;
		// Stale deferred messages must not be replayed after an abort.
		queryCtx.deferredUserMessages = [];
		for (const pending of queryCtx.pendingToolCalls.values()) {
			pending.resolve({ content: [{ type: "text", text: "Operation aborted" }] });
		}
		queryCtx.pendingToolCalls.clear();
		queryCtx.pendingResults.clear();
		// interrupt() asks the CLI to stop gracefully; close() kills it. Both are needed —
		// interrupt alone lets the in-flight API call run to completion.
		void sdkQuery.interrupt().catch(() => {});
		try { sdkQuery.close(); } catch { /* already closed */ }
	};
	queryCtx.abortActiveQuery = onAbort;
	if (options?.signal) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}

	const completion = consumeQuery(sdkQuery, customToolNameToPi, model, () => wasAborted, queryCtx)
		.then(async ({ capturedSessionId }) => {
			debug(`provider: consumeQuery completed, stopReason=${queryCtx.turnOutput?.stopReason}, error=${queryCtx.turnOutput?.errorMessage}, aborted=${wasAborted}`);

			if (wasAborted || options?.signal?.aborted) {
				markNeedsRebuild("provider: abort detected", { forceRotate: true });
				queryCtx.deferredUserMessages = [];
				terminateStreamWithError(queryCtx, model, "aborted", "Operation aborted");
				return;
			}

			const shared = getSharedSession();
			const sessionId = capturedSessionId ?? shared?.sessionId;
			if (syncResult.preserveSharedSession) {
				if (capturedSessionId && capturedSessionId !== shared?.sessionId) {
					discardEphemeralSession(capturedSessionId, cwd);
				}
				debug(`provider: query done, ignoring captured session ${capturedSessionId?.slice(0, 8) ?? "none"} to preserve shared session`);
			} else if (sessionId) {
				const cursor = Math.max(context.messages.length, queryCtx.latestCursor, shared?.cursor ?? 0);
				debug(`provider: query done, session=${sessionId.slice(0, 8)}, cursor=${cursor}`);
				setSharedSession({ sessionId, cursor, cwd });
			}

			await replayDeferredMessages(queryCtx, sdkQuery, queryOptions, model, customToolNameToPi, cliModel, cwd, isReentrant, () => wasAborted);

			if (!isReentrant && queryCtx.activeQuery === sdkQuery) {
				debug("provider: clearing activeQuery before final stream completion");
				queryCtx.activeQuery = null;
			}
			finalizeCurrentStream(queryCtx, queryCtx.turnOutput?.stopReason);
		})
		.catch((error: unknown) => {
			debug(`provider: query error, model=${cliModel}, aborted=${Boolean(options?.signal?.aborted)}, error=`, error);
			if (wasAborted || options?.signal?.aborted) {
				markNeedsRebuild("provider: error after abort", { forceRotate: true });
			} else {
				// A hard failure leaves the Claude Code session in an unknown state; drop it
				// so the next turn rebuilds from pi's history rather than resuming blind.
				setSharedSession(null);
			}
			queryCtx.deferredUserMessages = [];
			if (!isReentrant && queryCtx.activeQuery === sdkQuery) {
				for (const pending of queryCtx.pendingToolCalls.values()) {
					pending.resolve({ content: [{ type: "text", text: "Query ended" }] });
				}
				queryCtx.pendingToolCalls.clear();
				queryCtx.pendingResults.clear();
				debug("provider: clearing activeQuery before error stream completion");
				queryCtx.activeQuery = null;
			}
			const reason = wasAborted || options?.signal?.aborted ? "aborted" : "error";
			terminateStreamWithError(queryCtx, model, reason, errorMessage(error));
		})
		.finally(() => {
			options?.signal?.removeEventListener("abort", onAbort);
			if (queryCtx.activeQuery === sdkQuery) {
				for (const pending of queryCtx.pendingToolCalls.values()) {
					pending.resolve({ content: [{ type: "text", text: "Query ended" }] });
				}
				queryCtx.pendingToolCalls.clear();
				queryCtx.pendingResults.clear();
				queryCtx.activeQuery = null;
			}
			activeQueryContexts.delete(queryCtx);
			queryCtx.abortActiveQuery = null;
			queryCtx.activeQueryCompletion = null;
			sdkQuery.close();
		});
	queryCtx.activeQueryCompletion = completion;
}

/**
 * Replay steer/followUp messages that pi injected while the query was running.
 *
 * They couldn't be forwarded mid-query, so each becomes its own continuation query
 * resuming the same session. Reentrant queries skip this — the parent owns the replay.
 */
async function replayDeferredMessages(
	queryCtx: QueryContext,
	originalQuery: ReturnType<typeof query>,
	queryOptions: SdkOptions,
	model: BridgeModel,
	customToolNameToPi: Map<string, string>,
	cliModel: string,
	cwd: string,
	isReentrant: boolean,
	wasAborted: () => boolean,
): Promise<void> {
	try {
		while (queryCtx.deferredUserMessages.length > 0 && !isReentrant && !wasAborted()) {
			const steerPrompt = queryCtx.deferredUserMessages.shift();
			if (steerPrompt === undefined) break;
			debug(`provider: replaying deferred user message: ${steerPrompt.slice(0, 60)}`);
			queryCtx.resetTurnState(model);

			const resumeId = getSharedSession()?.sessionId;
			if (!resumeId) {
				debug("WARNING: no session to resume for deferred message, dropping");
				break;
			}

			const contOptions: SdkOptions = { ...queryOptions, resume: resumeId, ...makeCliDebugOptions("continuation") };
			const contQuery = query({ prompt: steerPrompt, options: contOptions });
			queryCtx.activeQuery = contQuery;
			debug(`provider: continuation query, model=${cliModel}, resume=${resumeId.slice(0, 8)}, prompt=${steerPrompt.slice(0, 60)}`);

			try {
				const { capturedSessionId } = await consumeQuery(contQuery, customToolNameToPi, model, wasAborted, queryCtx);
				const sid = capturedSessionId ?? getSharedSession()?.sessionId;
				if (sid) setSharedSession({ sessionId: sid, cursor: getSharedSession()?.cursor ?? 0, cwd });
			} catch (contError) {
				debug("provider: continuation query error:", contError);
				break;
			} finally {
				contQuery.close();
			}
		}
	} finally {
		queryCtx.activeQuery = originalQuery;
	}
}
