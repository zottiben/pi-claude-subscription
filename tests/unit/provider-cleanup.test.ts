// Completed stream results are shared with Pi's live transcript. Query cleanup must not
// change them after a tool handoff, even when compaction aborts the parked SDK query.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createAssistantMessageEventStream,
	normalizeContext,
	type Model,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { terminateStreamWithError } from "../../src/provider.js";
import { QueryContext } from "../../src/query-state.js";
import { finalizeCurrentStream, processStreamEvent } from "../../src/stream.js";
import type { BridgeModel } from "../../src/types.js";

const MODEL: BridgeModel = {
	id: "claude-opus-5-5",
	name: "Claude Opus 5.5",
	api: "claude-subscription",
	provider: "claude-subscription",
	baseUrl: "claude-code://subscription",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
};

const OPENAI_MODEL: Model<"openai-codex-responses"> = {
	...MODEL,
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
};

function startTurn(): QueryContext {
	const queryCtx = new QueryContext();
	queryCtx.resetTurnState(MODEL);
	queryCtx.currentPiStream = createAssistantMessageEventStream();
	return queryCtx;
}

describe("terminateStreamWithError", () => {
	for (const reason of ["aborted", "error"] as const) {
		it(`preserves the completed tool call for OpenAI replay after ${reason} cleanup`, async () => {
			const queryCtx = startTurn();
			const stream = queryCtx.currentPiStream!;
			const toolCallId = "toolu_completed_before_compaction";
			queryCtx.turnBlocks.push({ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "pwd" } });
			queryCtx.turnSawToolCall = true;
			processStreamEvent({ type: "message_stop" }, new Map(), MODEL, queryCtx);

			const completed = await stream.result();
			assert.equal(queryCtx.currentPiStream, null);
			assert.equal(completed, queryCtx.turnOutput);
			const snapshot = structuredClone(completed);
			const toolResult: ToolResultMessage = {
				role: "toolResult", toolCallId, toolName: "bash",
				content: [{ type: "text", text: "/project" }], isError: false, timestamp: 0,
			};
			const replay = () => convertResponsesMessages(OPENAI_MODEL, normalizeContext({ messages: [completed, toolResult] }), new Set(["openai-codex"]));
			const expected = replay();
			assert.deepEqual(expected.map((item) => item.type), ["function_call", "function_call_output"]);

			terminateStreamWithError(queryCtx, MODEL, reason, "Query cleanup");

			assert.deepEqual(replay(), expected, "cleanup must not leave OpenAI a tool result without its call");
			assert.deepEqual(completed, snapshot);
		});

		it(`preserves a completed text response after ${reason} cleanup`, async () => {
			const queryCtx = startTurn();
			const stream = queryCtx.currentPiStream!;
			queryCtx.turnBlocks.push({ type: "text", text: "Finished" });
			finalizeCurrentStream(queryCtx);
			const completed = await stream.result();
			const snapshot = structuredClone(completed);

			terminateStreamWithError(queryCtx, MODEL, reason, "Late cleanup");

			assert.deepEqual(completed, snapshot);
		});

		it(`terminates an active stream once with ${reason}`, async () => {
			const queryCtx = startTurn();
			const stream = queryCtx.currentPiStream!;
			queryCtx.turnBlocks.push({ type: "text", text: "Partial response" });

			terminateStreamWithError(queryCtx, MODEL, reason, "Active query failed");

			const result = await stream.result();
			assert.equal(result.stopReason, reason);
			assert.equal(result.errorMessage, "Active query failed");
			assert.deepEqual(result.content, [{ type: "text", text: "Partial response" }]);
			assert.equal(queryCtx.currentPiStream, null);
			const snapshot = structuredClone(result);

			terminateStreamWithError(queryCtx, MODEL, reason, "Repeated cleanup");

			const events = [];
			for await (const event of stream) events.push(event);
			assert.deepEqual(events, [{ type: "error", reason, error: result }]);
			assert.deepEqual(result, snapshot);
		});

		it(`synthesises a terminal ${reason} when an active stream has no output`, async () => {
			const queryCtx = new QueryContext();
			const stream = createAssistantMessageEventStream();
			queryCtx.currentPiStream = stream;

			terminateStreamWithError(queryCtx, MODEL, reason, "Setup failed");

			const result = await stream.result();
			assert.equal(result.role, "assistant");
			assert.equal(result.stopReason, reason);
			assert.equal(result.errorMessage, "Setup failed");
			assert.equal(result.provider, MODEL.provider);
			assert.equal(result.model, MODEL.id);
			assert.deepEqual(result.content, []);
			assert.equal(queryCtx.currentPiStream, null);
		});
	}
});
