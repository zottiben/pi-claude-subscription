// Unit tests for tool name/argument translation and the MCP handler queue.
//
// The queue is the deadlock-prone part of the design: MCP handlers block the SDK
// generator until pi delivers a result, and results can arrive either before or after
// their handler runs. Both orderings must resolve, and matching must be by id — never by
// position, since Claude Code can emit tool calls in any order.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { McpResult } from "../../src/extract-tool-results.js";
import { QueryContext } from "../../src/query-state.js";
import { mapToolArgs, mapToolName } from "../../src/tool-bridge.js";
import { MCP_TOOL_PREFIX } from "../../src/skills.js";

describe("mapToolName", () => {
	it("maps Claude Code built-ins to pi names", () => {
		assert.equal(mapToolName("Read"), "read");
		assert.equal(mapToolName("Bash"), "bash");
	});

	it("strips the MCP prefix from bridged pi tools", () => {
		assert.equal(mapToolName(`${MCP_TOOL_PREFIX}mytool`), "mytool");
	});

	it("prefers an explicit reverse mapping", () => {
		const custom = new Map([[`${MCP_TOOL_PREFIX}Weird`, "weird"]]);
		assert.equal(mapToolName(`${MCP_TOOL_PREFIX}Weird`, custom), "weird");
	});

	it("passes unknown names through untouched", () => {
		assert.equal(mapToolName("WebSearch"), "WebSearch");
	});
});

describe("mapToolArgs", () => {
	it("renames Claude Code parameter names to pi's", () => {
		assert.deepEqual(mapToolArgs("read", { file_path: "/a.ts" }), { path: "/a.ts" });
		assert.deepEqual(mapToolArgs("edit", { file_path: "/a.ts", old_string: "x", new_string: "y" }), {
			path: "/a.ts", oldText: "x", newText: "y",
		});
	});

	it("passes unmapped keys through, so new pi parameters need no change here", () => {
		assert.deepEqual(mapToolArgs("read", { path: "/a.ts", limit: 10 }), { path: "/a.ts", limit: 10 });
	});

	it("lets the first alias win when two map to the same key", () => {
		const args = mapToolArgs("edit", { old_string: "first", old_text: "second" });
		assert.equal(args.oldText, "first");
	});

	it("defaults the bash timeout, which pi otherwise leaves unbounded", () => {
		assert.equal(mapToolArgs("bash", { command: "ls" }).timeout, 120);
	});

	it("respects an explicit bash timeout", () => {
		assert.equal(mapToolArgs("bash", { command: "ls", timeout: 5 }).timeout, 5);
	});

	it("does not add a timeout to other tools", () => {
		assert.equal(mapToolArgs("read", { path: "/a.ts" }).timeout, undefined);
	});

	it("handles undefined arguments", () => {
		assert.deepEqual(mapToolArgs("read", undefined), {});
	});
});

// Mirrors what buildMcpServers' handler does, without spinning up a real MCP server.
function claimResult(c: QueryContext, toolName: string): Promise<McpResult> {
	const toolCallId = c.turnToolCallIds[c.nextHandlerIdx++];
	assert.ok(toolCallId, "handler should have an id");
	const queued = c.pendingResults.get(toolCallId);
	if (queued) {
		c.pendingResults.delete(toolCallId);
		return Promise.resolve(queued);
	}
	return new Promise<McpResult>((resolve) => {
		c.pendingToolCalls.set(toolCallId, { toolName, resolve });
	});
}

/** Mirrors the provider's tool-result delivery. */
function deliver(c: QueryContext, results: McpResult[]): void {
	for (const result of results) {
		const id = result.toolCallId;
		if (!id) continue;
		const pending = c.pendingToolCalls.get(id);
		if (pending) {
			c.pendingToolCalls.delete(id);
			pending.resolve(result);
		} else {
			c.pendingResults.set(id, result);
		}
	}
}

function textResult(toolCallId: string, text: string, isError = false): McpResult {
	return { toolCallId, content: [{ type: "text", text }], isError };
}

describe("MCP handler queue", () => {
	it("resolves handlers that ran before their results arrived", async () => {
		const c = new QueryContext();
		c.turnToolCallIds = ["a", "b"];

		const pending = [claimResult(c, "read"), claimResult(c, "bash")];
		assert.equal(c.pendingToolCalls.size, 2, "both handlers should be parked");

		deliver(c, [textResult("a", "A"), textResult("b", "B")]);
		const resolved = await Promise.all(pending);
		assert.deepEqual(resolved.map((r) => r.content[0]), [{ type: "text", text: "A" }, { type: "text", text: "B" }]);
		assert.equal(c.pendingToolCalls.size, 0);
	});

	it("resolves immediately from the queue when results arrived first", async () => {
		const c = new QueryContext();
		c.turnToolCallIds = ["a", "b"];

		deliver(c, [textResult("a", "A"), textResult("b", "B")]);
		assert.equal(c.pendingResults.size, 2);

		assert.equal((await claimResult(c, "read")).toolCallId, "a");
		assert.equal((await claimResult(c, "bash")).toolCallId, "b");
		assert.equal(c.pendingResults.size, 0);
	});

	it("matches by id, not by arrival order", async () => {
		const c = new QueryContext();
		c.turnToolCallIds = ["a", "b", "c"];

		const pending = [claimResult(c, "t1"), claimResult(c, "t2"), claimResult(c, "t3")];
		deliver(c, [textResult("c", "C"), textResult("a", "A"), textResult("b", "B")]);

		const resolved = await Promise.all(pending);
		assert.deepEqual(resolved.map((r) => r.toolCallId), ["a", "b", "c"]);
	});

	it("handles a handler and a queued result interleaving", async () => {
		const c = new QueryContext();
		c.turnToolCallIds = ["a", "b"];

		// First tool: handler parks, then its result arrives and unblocks it.
		const first = claimResult(c, "read");
		deliver(c, [textResult("a", "A")]);
		assert.deepEqual((await first).content[0], { type: "text", text: "A" });

		// Second tool: result arrives first, so the handler resolves straight from the queue.
		deliver(c, [textResult("b", "B")]);
		const second = await claimResult(c, "bash");
		assert.equal(second.toolCallId, "b");
		assert.deepEqual(second.content[0], { type: "text", text: "B" });
		assert.equal(c.pendingResults.size, 0, "the queue should be drained");
	});

	it("propagates isError through both paths", async () => {
		const c = new QueryContext();
		c.turnToolCallIds = ["a", "b"];

		const parked = claimResult(c, "read");
		deliver(c, [textResult("a", "boom", true)]);
		assert.equal((await parked).isError, true);

		deliver(c, [textResult("b", "boom", true)]);
		assert.equal((await claimResult(c, "bash")).isError, true);
	});

	it("drains every waiting handler when a query ends", async () => {
		const c = new QueryContext();
		c.turnToolCallIds = ["a", "b"];
		const pending = [claimResult(c, "read"), claimResult(c, "bash")];

		for (const handler of c.pendingToolCalls.values()) {
			handler.resolve({ content: [{ type: "text", text: "Query ended" }] });
		}
		c.pendingToolCalls.clear();

		const resolved = await Promise.all(pending);
		assert.equal(resolved.length, 2, "no handler may be left blocking the generator");
		assert.deepEqual(resolved[0]?.content[0], { type: "text", text: "Query ended" });
	});
});
