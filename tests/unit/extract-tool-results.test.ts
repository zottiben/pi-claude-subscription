// Unit tests for the context-tail walk that recovers this turn's tool results.
//
// The walk boundary is the subtle part: pi can inject user messages (steer/followUp)
// between tool results, and those must be stepped over rather than treated as the
// boundary — but the previous assistant message must stop the walk, or results from an
// earlier turn get replayed.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	extractAllToolResults,
	toolResultToMcpContent,
	type LooseMessage,
} from "../../src/extract-tool-results.js";

const assistantMsg: LooseMessage = { role: "assistant", content: [] };
const userMsg = (text: string): LooseMessage => ({ role: "user", content: text });
const result = (id: string, text = "ok", isError = false): LooseMessage =>
	({ role: "toolResult", toolCallId: id, content: text, isError });

function ids(messages: LooseMessage[]): (string | undefined)[] {
	return extractAllToolResults(messages).results.map((r) => r.toolCallId);
}

describe("extractAllToolResults turn boundary", () => {
	it("collects every result after the last assistant message", () => {
		assert.deepEqual(ids([assistantMsg, result("a"), result("b"), result("c")]), ["a", "b", "c"]);
	});

	it("ignores results belonging to a previous turn", () => {
		assert.deepEqual(ids([
			assistantMsg, result("old1"), result("old2"),
			assistantMsg, result("new1"),
		]), ["new1"]);
	});

	it("reports where the walk stopped", () => {
		const { stopIdx } = extractAllToolResults([assistantMsg, result("a"), result("b")]);
		assert.equal(stopIdx, 0);
	});

	it("reports -1 when no assistant message bounds the walk", () => {
		const { stopIdx } = extractAllToolResults([result("a")]);
		assert.equal(stopIdx, -1);
	});
});

describe("extractAllToolResults interleaved user messages", () => {
	it("steps over a trailing user message to reach the results behind it", () => {
		assert.deepEqual(ids([assistantMsg, result("a"), userMsg("steer")]), ["a"]);
	});

	it("steps over a user message sitting between two results", () => {
		assert.deepEqual(ids([assistantMsg, result("a"), userMsg("steer"), result("b")]), ["a", "b"]);
	});

	it("handles a user message before every result", () => {
		assert.deepEqual(ids([
			assistantMsg, userMsg("s1"), result("a"), userMsg("s2"), result("b"),
		]), ["a", "b"]);
	});

	it("preserves original order despite the reverse walk", () => {
		assert.deepEqual(ids([
			assistantMsg, result("a"), result("b"), userMsg("s"), result("c"), result("d"), result("e"),
		]), ["a", "b", "c", "d", "e"]);
	});
});

describe("extractAllToolResults edge cases", () => {
	it("returns nothing for an empty context", () => {
		assert.deepEqual(ids([]), []);
	});

	it("returns nothing for a user message alone", () => {
		assert.deepEqual(ids([userMsg("hi")]), []);
	});

	it("returns nothing when the turn has a tool call but no results yet", () => {
		assert.deepEqual(ids([userMsg("hi"), assistantMsg]), []);
	});

	it("collects results even with no assistant message at all", () => {
		assert.deepEqual(ids([result("a"), result("b")]), ["a", "b"]);
	});

	it("propagates the isError flag", () => {
		const { results } = extractAllToolResults([assistantMsg, result("a", "boom", true)]);
		assert.equal(results[0]?.isError, true);
	});
});

describe("toolResultToMcpContent", () => {
	it("wraps a plain string", () => {
		assert.deepEqual(toolResultToMcpContent("hello"), [{ type: "text", text: "hello" }]);
	});

	it("keeps text and image blocks", () => {
		assert.deepEqual(
			toolResultToMcpContent([
				{ type: "text", text: "a" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
			]),
			[{ type: "text", text: "a" }, { type: "image", data: "AAAA", mimeType: "image/png" }],
		);
	});

	it("drops image blocks missing data or mimeType", () => {
		assert.deepEqual(toolResultToMcpContent([{ type: "image", data: "AAAA" }]), [{ type: "text", text: "" }]);
	});

	it("always yields at least one block, since MCP rejects empty content", () => {
		assert.deepEqual(toolResultToMcpContent([]), [{ type: "text", text: "" }]);
		assert.deepEqual(toolResultToMcpContent(undefined), [{ type: "text", text: "" }]);
		assert.deepEqual(toolResultToMcpContent(""), [{ type: "text", text: "" }]);
	});
});
