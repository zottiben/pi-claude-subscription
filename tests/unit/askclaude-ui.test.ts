// Unit tests for the AskClaude status-line summary.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildActionSummary,
	extractPath,
	formatToolAction,
	shortPath,
	type ToolCallState,
} from "../../src/askclaude-ui.js";

function call(name: string, rawInput?: unknown): ToolCallState {
	return { name, status: "complete", rawInput };
}

describe("extractPath", () => {
	it("prefers file_path, then path", () => {
		assert.equal(extractPath({ file_path: "/a/b.ts" }), "/a/b.ts");
		assert.equal(extractPath({ path: "/c/d.ts" }), "/c/d.ts");
	});

	it("falls back to a truncated command", () => {
		assert.equal(extractPath({ command: "git status" }), "git status");
		assert.equal(extractPath({ command: "x".repeat(200) })?.length, 80);
	});

	it("returns undefined for non-object input", () => {
		assert.equal(extractPath(undefined), undefined);
		assert.equal(extractPath("nope"), undefined);
	});
});

describe("shortPath", () => {
	it("strips the cwd prefix", () => {
		assert.equal(shortPath(`${process.cwd()}/src/index.ts`), "src/index.ts");
	});

	it("keeps the last two segments of an unrelated absolute path", () => {
		assert.equal(shortPath("/usr/local/share/thing.ts"), "share/thing.ts");
	});

	it("leaves relative paths alone", () => {
		assert.equal(shortPath("src/index.ts"), "src/index.ts");
	});
});

describe("formatToolAction", () => {
	it("labels file tools with a shortened path", () => {
		assert.equal(formatToolAction(call("read", { file_path: `${process.cwd()}/a.ts` })), "Read(a.ts)");
		assert.equal(formatToolAction(call("write", { file_path: `${process.cwd()}/b.ts` })), "Edit(b.ts)");
	});

	it("labels pattern tools with the pattern", () => {
		assert.equal(formatToolAction(call("grep", { pattern: "TODO" })), "Grep(TODO)");
		assert.equal(formatToolAction(call("glob", { pattern: "**/*.ts" })), "Glob(**/*.ts)");
	});

	it("falls back to a bare label when the argument is missing", () => {
		assert.equal(formatToolAction(call("read")), "Read");
		assert.equal(formatToolAction(call("grep")), "Grep");
	});

	it("hides tools that would be noise", () => {
		assert.equal(formatToolAction(call("bashoutput", {})), undefined, "redundant with the preceding Bash");
		assert.equal(formatToolAction(call("askclaude", {})), undefined, "recursive");
	});

	it("shows the active todo rather than the tool name", () => {
		const action = formatToolAction(call("todowrite", {
			todos: [{ status: "completed", content: "done thing" }, { status: "in_progress", content: "current thing" }],
		}));
		assert.equal(action, "current thing");
	});

	it("falls back to a pending todo when nothing is in progress", () => {
		assert.equal(formatToolAction(call("taskcreate", { todos: [{ status: "pending", content: "next thing" }] })), "next thing");
	});

	it("passes unknown tools through by name", () => {
		assert.equal(formatToolAction(call("SomeNewTool", {})), "SomeNewTool");
	});
});

describe("buildActionSummary", () => {
	it("joins distinct actions in order", () => {
		const calls = new Map<string, ToolCallState>([
			["1", call("read", { file_path: "a.ts" })],
			["2", call("grep", { pattern: "x" })],
		]);
		assert.equal(buildActionSummary(calls), "Read(a.ts); Grep(x)");
	});

	it("collapses consecutive calls to the same tool, keeping the latest", () => {
		const calls = new Map<string, ToolCallState>([
			["1", call("read", { file_path: "a.ts" })],
			["2", call("read", { file_path: "b.ts" })],
			["3", call("read", { file_path: "c.ts" })],
		]);
		assert.equal(buildActionSummary(calls), "Read(c.ts)");
	});

	it("does not collapse across an intervening tool", () => {
		const calls = new Map<string, ToolCallState>([
			["1", call("read", { file_path: "a.ts" })],
			["2", call("grep", { pattern: "x" })],
			["3", call("read", { file_path: "b.ts" })],
		]);
		assert.equal(buildActionSummary(calls), "Read(a.ts); Grep(x); Read(b.ts)");
	});

	it("skips hidden tools without breaking collapsing", () => {
		const calls = new Map<string, ToolCallState>([
			["1", call("bash", { command: "ls" })],
			["2", call("bashoutput", {})],
		]);
		assert.equal(buildActionSummary(calls), "Bash(ls)");
	});

	it("returns empty for no calls", () => {
		assert.equal(buildActionSummary(new Map()), "");
	});
});
