// Per-query and per-turn mutable state.
//
// A QueryContext owns everything that must not leak between concurrent Claude Code
// queries. The top-level turn uses the module-level instance from `ctx()`; reentrant
// queries (a subagent starting while the parent is mid-turn) each construct their own,
// so their pending tool handlers and stream references stay separate.
//
// Adding new per-query state means adding one property here — nothing else.
// Kept separate from index.ts so tests can import without activating the extension.

import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "@earendil-works/pi-ai";
import type { McpResult } from "./extract-tool-results.js";
import type { BridgeModel } from "./types.js";

/**
 * An assistant content block while it is still being streamed.
 *
 * `index` is the Anthropic stream's content_block index, used to correlate deltas with
 * the block they belong to; `partialJson` accumulates a tool call's arguments across
 * input_json_delta events. Both are scratch fields, deleted at content_block_stop so
 * what remains is a clean pi content block.
 */
export type StreamingBlock =
	| (TextContent & { index?: number })
	| (ThinkingContent & { index?: number })
	| (ToolCall & { index?: number; partialJson?: string });

export interface PendingToolCall {
	toolName: string;
	resolve: (result: McpResult) => void;
}

export class QueryContext {
	// --- Query-scoped: fully isolated per query ---

	activeQuery: Query | null = null;
	/** Abort callback and completion barrier used to rotate a live query before compaction. */
	abortActiveQuery: (() => void) | null = null;
	activeQueryCompletion: Promise<void> | null = null;
	/** The next provider call must rebuild and continue instead of treating its tool result as orphaned. */
	resumeAfterCompaction = false;
	currentPiStream: AssistantMessageEventStream | null = null;
	/** Highest pi context length observed for this query; used to advance the session cursor. */
	latestCursor = 0;
	/** MCP handlers parked waiting for pi to deliver their tool result, keyed by tool call id. */
	pendingToolCalls = new Map<string, PendingToolCall>();
	/** Results that arrived before their handler ran, keyed by tool call id. */
	pendingResults = new Map<string, McpResult>();
	/** Tool call ids emitted by the current assistant message, in emission order. */
	turnToolCallIds: string[] = [];
	nextHandlerIdx = 0;
	/** Steer/followUp prompts pi injected mid-query, replayed once the query ends. */
	deferredUserMessages: string[] = [];

	// --- Per-turn: reset together by resetTurnState ---

	turnOutput: AssistantMessage | null = null;
	turnStarted = false;
	turnSawStreamEvent = false;
	turnSawToolCall = false;

	get turnBlocks(): StreamingBlock[] {
		if (!this.turnOutput) throw new Error("turnBlocks accessed before resetTurnState");
		return this.turnOutput.content as StreamingBlock[];
	}

	resetTurnState(model: BridgeModel): void {
		this.turnOutput = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		this.turnStarted = false;
		this.turnSawStreamEvent = false;
		this.turnSawToolCall = false;
		// turnToolCallIds and nextHandlerIdx are deliberately NOT reset — they persist
		// across tool-result delivery callbacks within the same assistant message.
	}
}

let current = new QueryContext();

/** The top-level query context. Reentrant queries construct their own instead. */
export function ctx(): QueryContext {
	return current;
}

/** Drop all top-level query state and return the replacement context. */
export function resetContext(): QueryContext {
	current = new QueryContext();
	return current;
}
