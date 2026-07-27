// Unit tests for per-query / per-turn state.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ctx, QueryContext, resetContext } from "../../src/query-state.js";
import type { BridgeModel } from "../../src/types.js";

const MODEL = {
	id: "claude-opus-4-8",
	name: "Claude Opus 4.8",
	api: "claude-subscription",
	provider: "claude-subscription",
	baseUrl: "claude-subscription",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
} as BridgeModel;

describe("QueryContext.resetTurnState", () => {
	it("installs a fresh assistant message stamped with the model", () => {
		const c = new QueryContext();
		c.resetTurnState(MODEL);
		assert.equal(c.turnOutput?.model, "claude-opus-4-8");
		assert.equal(c.turnOutput?.stopReason, "stop");
		assert.deepEqual(c.turnOutput?.content, []);
	});

	it("clears the per-turn flags", () => {
		const c = new QueryContext();
		c.resetTurnState(MODEL);
		c.turnStarted = true;
		c.turnSawStreamEvent = true;
		c.turnSawToolCall = true;

		c.resetTurnState(MODEL);
		assert.equal(c.turnStarted, false);
		assert.equal(c.turnSawStreamEvent, false);
		assert.equal(c.turnSawToolCall, false);
	});

	// These survive on purpose: tool-result delivery calls resetTurnState again within the
	// same assistant message, and the ids are what match results to waiting handlers.
	it("preserves turnToolCallIds and nextHandlerIdx across a reset", () => {
		const c = new QueryContext();
		c.resetTurnState(MODEL);
		c.turnToolCallIds = ["a", "b"];
		c.nextHandlerIdx = 2;

		c.resetTurnState(MODEL);
		assert.deepEqual(c.turnToolCallIds, ["a", "b"]);
		assert.equal(c.nextHandlerIdx, 2);
	});

	it("does not carry content between turns", () => {
		const c = new QueryContext();
		c.resetTurnState(MODEL);
		c.turnBlocks.push({ type: "text", text: "old" });
		c.resetTurnState(MODEL);
		assert.deepEqual(c.turnBlocks, []);
	});
});

describe("QueryContext.turnBlocks", () => {
	it("throws rather than silently dropping content when accessed before a reset", () => {
		const c = new QueryContext();
		assert.throws(() => c.turnBlocks, /turnBlocks accessed before resetTurnState/);
	});

	it("aliases turnOutput.content, so pushes are visible to the stream", () => {
		const c = new QueryContext();
		c.resetTurnState(MODEL);
		c.turnBlocks.push({ type: "text", text: "hi" });
		assert.equal(c.turnOutput?.content.length, 1);
	});
});

describe("QueryContext isolation", () => {
	it("gives each instance its own maps, so concurrent queries can't cross-resolve", () => {
		const a = new QueryContext();
		const b = new QueryContext();
		a.pendingToolCalls.set("t1", { toolName: "bash", resolve: () => {} });
		assert.equal(b.pendingToolCalls.size, 0);
		assert.notEqual(a.pendingResults, b.pendingResults);
	});
});

describe("ctx", () => {
	it("returns a stable top-level context", () => {
		assert.equal(ctx(), ctx());
	});

	it("is replaced by resetContext", () => {
		const before = ctx();
		resetContext();
		assert.notEqual(ctx(), before);
	});
});
