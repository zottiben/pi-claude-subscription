// Unit tests for config discovery and global/project merging.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { loadConfig, tryParseJson } from "../../src/config.js";
import { CONFIG_FILE_NAME } from "../../src/constants.js";

/** loadConfig reads the global file relative to homedir(), which follows $HOME. */
function withTempHome<T>(fn: (home: string) => T): T {
	const oldHome = process.env.HOME;
	const home = mkdtempSync(join(tmpdir(), "claude-subscription-home-"));
	try {
		process.env.HOME = home;
		return fn(home);
	} finally {
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
		rmSync(home, { recursive: true, force: true });
	}
}

function withTempDir<T>(fn: (dir: string) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "claude-subscription-project-"));
	try {
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function writeConfig(dir: string, contents: unknown): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, CONFIG_FILE_NAME), typeof contents === "string" ? contents : JSON.stringify(contents));
}

describe("loadConfig", () => {
	it("reads project config from pi's configured project directory", () => withTempHome(() => withTempDir((cwd) => {
		writeConfig(join(cwd, CONFIG_DIR_NAME), { provider: { plan: "max" }, askClaude: { enabled: false } });
		assert.deepEqual(loadConfig(cwd), { provider: { plan: "max" }, askClaude: { enabled: false } });
	})));

	it("merges project over global, key by key", () => withTempHome((home) => withTempDir((cwd) => {
		writeConfig(join(home, ".pi", "agent"), {
			provider: { plan: "pro", strictMcpConfig: true },
			askClaude: { enabled: true, defaultMode: "read" },
		});
		writeConfig(join(cwd, CONFIG_DIR_NAME), {
			provider: { plan: "max" },
			askClaude: { enabled: false },
		});

		assert.deepEqual(loadConfig(cwd), {
			provider: { plan: "max", strictMcpConfig: true },
			askClaude: { enabled: false, defaultMode: "read" },
		});
	})));

	it("returns empty sections when no config exists anywhere", () => withTempHome(() => withTempDir((cwd) => {
		assert.deepEqual(loadConfig(cwd), { provider: {}, askClaude: {} });
	})));
});

describe("tryParseJson", () => {
	it("returns empty for a missing file", () => {
		assert.deepEqual(tryParseJson(join(tmpdir(), "definitely-not-here-9f3a.json")), {});
	});

	it("returns empty and reports rather than throwing on malformed JSON", () => withTempDir((dir) => {
		writeConfig(dir, "{ not json");
		const originalError = console.error;
		const seen: unknown[] = [];
		console.error = (...args: unknown[]) => { seen.push(args); };
		try {
			assert.deepEqual(tryParseJson(join(dir, CONFIG_FILE_NAME)), {});
			assert.equal(seen.length, 1);
		} finally {
			console.error = originalError;
		}
	}));

	it("rejects a JSON array, which would otherwise spread into nonsense", () => withTempDir((dir) => {
		writeConfig(dir, ["nope"]);
		const originalError = console.error;
		console.error = () => {};
		try {
			assert.deepEqual(tryParseJson(join(dir, CONFIG_FILE_NAME)), {});
		} finally {
			console.error = originalError;
		}
	}));
});
