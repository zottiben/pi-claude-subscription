// Unit tests for the post-write session file integrity check.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { verifyWrittenSession } from "../../src/session-verify.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

function withSessionFile<T>(lines: string[], fn: (path: string) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "session-verify-"));
	const path = join(dir, "session.jsonl");
	writeFileSync(path, lines.join("\n") + (lines.length ? "\n" : ""));
	try {
		return fn(path);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function record(sessionId: string, i: number): string {
	return JSON.stringify({ sessionId, uuid: `u${i}`, type: "user" });
}

describe("verifyWrittenSession", () => {
	it("reports nothing for a well-formed file", () => {
		withSessionFile([record(SESSION_ID, 1), record(SESSION_ID, 2)], (path) => {
			assert.deepEqual(verifyWrittenSession(path, SESSION_ID, 2), []);
		});
	});

	it("ignores trailing blank lines when counting records", () => {
		withSessionFile([record(SESSION_ID, 1), "", "  "], (path) => {
			assert.deepEqual(verifyWrittenSession(path, SESSION_ID, 1), []);
		});
	});

	it("flags a missing file", () => {
		const warnings = verifyWrittenSession(join(tmpdir(), "nope-8a2f.jsonl"), SESSION_ID, 1);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0] ?? "", /file missing after save/);
	});

	it("flags a record count mismatch", () => {
		withSessionFile([record(SESSION_ID, 1)], (path) => {
			const warnings = verifyWrittenSession(path, SESSION_ID, 5);
			assert.equal(warnings.length, 1);
			assert.match(warnings[0] ?? "", /record count mismatch — expected=5 actual=1/);
		});
	});

	it("flags a session id that drifted from what we wrote", () => {
		withSessionFile([record(SESSION_ID, 1), record("22222222-2222-4222-8222-222222222222", 2)], (path) => {
			const warnings = verifyWrittenSession(path, SESSION_ID, 2);
			assert.equal(warnings.length, 1);
			assert.match(warnings[0] ?? "", /sessionId drift/);
		});
	});

	it("flags malformed JSONL", () => {
		withSessionFile(["{ not json", record(SESSION_ID, 2)], (path) => {
			const warnings = verifyWrittenSession(path, SESSION_ID, 2);
			assert.equal(warnings.length, 1);
			assert.match(warnings[0] ?? "", /malformed JSONL/);
		});
	});

	it("stops at the count mismatch rather than also reporting drift", () => {
		withSessionFile([record("other-id", 1)], (path) => {
			const warnings = verifyWrittenSession(path, SESSION_ID, 9);
			assert.equal(warnings.length, 1, "a wrong-length file should produce one actionable warning");
		});
	});
});
