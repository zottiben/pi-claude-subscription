// End-to-end tests that drive the real `pi` binary against a real Claude subscription.
//
// These are NOT part of `npm test`: they need `pi` installed, a logged-in Claude Code, and
// they consume subscription quota. Run them with `npm run test:integration`.
//
// Everything here goes through pi's own CLI rather than calling the extension directly,
// because the failure modes worth catching (extension fails to load, provider never
// registers, the MCP bridge deadlocks, session resume silently loses history) only appear
// once pi is actually driving.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXTENSION = join(REPO_ROOT, "src", "index.ts");

/** Cheapest model that still exercises the full path. */
const MODEL = "claude-subscription/claude-haiku-4-5";
const TIMEOUT_MS = 180_000;

interface RunResult {
	stdout: string;
	stderr: string;
	code: number | null;
}

function runPi(args: string[], env: NodeJS.ProcessEnv = {}): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		// -ne disables extension discovery so the developer's own installed extensions
		// (including a published copy of this one) can't influence the result.
		const child = spawn("pi", ["-ne", "-e", EXTENSION, ...args], {
			cwd: REPO_ROOT,
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
		child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`pi timed out after ${TIMEOUT_MS}ms\nstdout: ${stdout}\nstderr: ${stderr}`));
		}, TIMEOUT_MS);

		child.on("error", (err) => { clearTimeout(timer); reject(err); });
		child.on("close", (code) => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
	});
}

let sessionDir: string;

before(() => {
	sessionDir = mkdtempSync(join(tmpdir(), "claude-subscription-it-"));
});

after(() => {
	rmSync(sessionDir, { recursive: true, force: true });
});

describe("extension registration", { timeout: TIMEOUT_MS }, () => {
	it("registers every catalogue model with pi", async () => {
		const { stdout, code } = await runPi(["--list-models", "claude-subscription"]);
		assert.equal(code, 0);
		// Opus 5.5 and Fable 5.1 are absent from the minimum supported pi-ai version, so they
		// only appear if the local fallbacks survive a real registration through pi.
		for (const id of ["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5"]) {
			assert.match(stdout, new RegExp(`claude-subscription\\s+${id}`), `${id} should be registered`);
		}
	});

	it("registers the 1M context window where the plan allows it", async () => {
		const { stdout } = await runPi(["--list-models", "claude-subscription"]);
		assert.match(stdout, /claude-opus-5-5\s+1M/, "Opus 5.5 always gets 1M");
		assert.match(stdout, /claude-opus-5\s+1M/, "Opus 5 always gets 1M");
		assert.match(stdout, /claude-fable-5-1\s+1M/, "Fable 5.1 always gets 1M");
		assert.match(stdout, /claude-opus-4-8\s+1M/, "Opus 4.8 always gets 1M");
		assert.match(stdout, /claude-haiku-4-5\s+200K/, "Haiku never does");
	});
});

describe("provider turn", { timeout: TIMEOUT_MS }, () => {
	it("completes a plain turn", async () => {
		const { stdout, code } = await runPi([
			"--model", MODEL, "-p", "Reply with exactly the word PONG and nothing else.",
		]);
		assert.equal(code, 0);
		assert.match(stdout, /PONG/);
	});

	// The MCP bridge is the deadlock-prone path: Claude Code requests a tool, pi runs it,
	// and the result has to travel back through a blocked handler.
	it("round-trips a tool call through pi and back", async () => {
		const { stdout, code } = await runPi([
			"--model", MODEL, "-p", "Use the bash tool to run 'echo BRIDGE_OK' and tell me the exact output.",
		]);
		assert.equal(code, 0);
		assert.match(stdout, /BRIDGE_OK/);
	});
});

describe("session continuity", { timeout: TIMEOUT_MS }, () => {
	it("carries history across turns, so Claude Code sees the conversation", async () => {
		const first = await runPi([
			"--session-dir", sessionDir, "--model", MODEL,
			"-p", "My favourite colour is chartreuse. Reply with just OK.",
		]);
		assert.equal(first.code, 0);

		const second = await runPi([
			"--session-dir", sessionDir, "-c", "--model", MODEL,
			"-p", "What is my favourite colour? Answer in one word.",
		]);
		assert.equal(second.code, 0);
		assert.match(second.stdout, /chartreuse/i, "the rebuilt session must carry the earlier turn");
	});
});
