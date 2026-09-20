// Unit tests for the REUSE / REBUILD decision in syncSharedSession.
//
// This is the state machine that decides whether Claude Code resumes an existing session
// or gets a freshly written one. Getting it wrong either flushes the prompt cache on every
// turn (cheap to notice) or resumes a session that no longer matches pi's history (very
// expensive to notice), so the branches are pinned here.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import {
	clearSharedSession,
	getSharedSession,
	markNeedsRebuild,
	setSharedSession,
	syncSharedSession,
} from "../../src/session-sync.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

function system(content = ""): Message {
	return { role: "system", content, timestamp: 0 } as unknown as Message;
}

function user(text: string): Message {
	return { role: "user", content: text, timestamp: 0 };
}

function assistantMsg(text: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-4-8",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 0,
	};
}

function withCwd<T>(fn: (cwd: string) => T): T {
	const cwd = mkdtempSync(join(tmpdir(), "session-sync-"));
	try {
		return fn(cwd);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

// syncSharedSession writes real session JSONL through cc-session-io, which defaults to
// ~/.claude/projects. Redirect it at a throwaway dir so the suite never touches the
// developer's actual Claude Code state.
let claudeDir: string;
let previousClaudeConfigDir: string | undefined;

before(() => {
	previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
	claudeDir = mkdtempSync(join(tmpdir(), "session-sync-claude-"));
	process.env.CLAUDE_CONFIG_DIR = claudeDir;
});

after(() => {
	if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
	else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
	rmSync(claudeDir, { recursive: true, force: true });
});

afterEach(() => clearSharedSession());

describe("syncSharedSession clean start", () => {
	it("starts clean on the very first prompt", () => withCwd((cwd) => {
		assert.deepEqual(syncSharedSession([user("hi")], cwd), { sessionId: null });
		assert.equal(getSharedSession(), null);
	}));

	it("starts clean when the first prompt is preceded only by Pi's initial system message", () => withCwd((cwd) => {
		assert.deepEqual(syncSharedSession([system(), user("hi")], cwd), { sessionId: null });
		assert.equal(getSharedSession(), null);
	}));
});

describe("syncSharedSession REUSE", () => {
	it("resumes when the cursor already covers every prior message", () => withCwd((cwd) => {
		setSharedSession({ sessionId: SESSION_ID, cursor: 2, cwd });
		const result = syncSharedSession([user("a"), assistantMsg("b"), user("c")], cwd);
		assert.equal(result.sessionId, SESSION_ID);
		assert.equal(getSharedSession()?.cursor, 2, "an exact match should not move the cursor");
	}));

	it("resumes and advances past the trailing assistant message pi appends after a turn", () => withCwd((cwd) => {
		setSharedSession({ sessionId: SESSION_ID, cursor: 1, cwd });
		const result = syncSharedSession([user("a"), assistantMsg("b"), user("c")], cwd);
		assert.equal(result.sessionId, SESSION_ID, "Claude Code already persisted that assistant turn itself");
		assert.equal(getSharedSession()?.cursor, 2);
	}));

	it("does NOT reuse when a non-trailing gap means another provider took a turn", () => withCwd((cwd) => {
		setSharedSession({ sessionId: SESSION_ID, cursor: 0, cwd });
		const result = syncSharedSession([user("a"), assistantMsg("b"), user("c")], cwd);
		assert.notEqual(result.sessionId, null, "should rebuild, not clean-start");
		assert.equal(getSharedSession()?.cursor, 2);
	}));
});

describe("syncSharedSession shorter context", () => {
	// Regression: a shorter context makes missed = [].slice(cursor) === [], which would
	// otherwise look like a clean REUSE and resume an unrelated, longer session.
	it("does not reuse the main session for a shorter synthetic compact context", () => withCwd((cwd) => {
		const main = { sessionId: SESSION_ID, cursor: 42, cwd };
		setSharedSession(main);

		const result = syncSharedSession([user("Summarize this conversation.")], cwd);

		assert.equal(result.sessionId, null, "a synthetic compact context must start a fresh Claude Code session");
		assert.equal(result.preserveSharedSession, true, "and must not replace the cached main session when it finishes");
		assert.deepEqual(getSharedSession(), main);
	}));
});

describe("syncSharedSession REBUILD", () => {
	it("writes a session covering all prior messages on the first multi-message turn", () => withCwd((cwd) => {
		const result = syncSharedSession([user("a"), assistantMsg("b"), user("c")], cwd);
		assert.ok(result.sessionId, "expected a session id");
		assert.equal(getSharedSession()?.cursor, 2, "cursor covers everything before the new prompt");
	}));

	it("keeps the same session id across an in-place rebuild", () => withCwd((cwd) => {
		const first = syncSharedSession([user("a"), assistantMsg("b"), user("c")], cwd);
		markNeedsRebuild("test");
		const second = syncSharedSession([user("a"), assistantMsg("b"), user("c"), assistantMsg("d"), user("e")], cwd);
		assert.equal(second.sessionId, first.sessionId, "a stable id keeps logs correlatable and leaves no orphan files");
	}));

	it("rotates to a new id after an abort, to avoid racing the orphan writer", () => withCwd((cwd) => {
		const first = syncSharedSession([user("a"), assistantMsg("b"), user("c")], cwd);
		markNeedsRebuild("test-abort", { forceRotate: true });
		const second = syncSharedSession([user("a"), assistantMsg("b"), user("c"), assistantMsg("d"), user("e")], cwd);
		assert.notEqual(second.sessionId, first.sessionId);
	}));

	it("rebuilds rather than reusing once needsRebuild is set, even with no gap", () => withCwd((cwd) => {
		syncSharedSession([user("a"), assistantMsg("b"), user("c")], cwd);
		const idBefore = getSharedSession()?.sessionId;
		markNeedsRebuild("compact");
		syncSharedSession([user("a"), assistantMsg("b"), user("c")], cwd);
		assert.equal(getSharedSession()?.needsRebuild, undefined, "the rebuild should clear the flag");
		assert.equal(getSharedSession()?.sessionId, idBefore);
	}));
});

describe("markNeedsRebuild", () => {
	it("is a no-op when there is no session", () => {
		markNeedsRebuild("nothing-to-do");
		assert.equal(getSharedSession(), null);
	});
});
