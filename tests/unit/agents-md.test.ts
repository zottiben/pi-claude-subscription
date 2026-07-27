// Unit tests for AGENTS.md discovery and pi -> Claude Code rewriting.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { extractAgentsAppend, findAgentsMdInParents, sanitizeAgentsContent } from "../../src/agents-md.js";

function withTree<T>(fn: (root: string) => T): T {
	const root = mkdtempSync(join(tmpdir(), "agents-md-"));
	try {
		return fn(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("findAgentsMdInParents", () => {
	it("finds the file in the starting directory", () => withTree((root) => {
		writeFileSync(join(root, "AGENTS.md"), "# hi");
		assert.equal(findAgentsMdInParents(root), join(root, "AGENTS.md"));
	}));

	it("walks up to a parent directory", () => withTree((root) => {
		writeFileSync(join(root, "AGENTS.md"), "# hi");
		const nested = join(root, "a", "b", "c");
		mkdirSync(nested, { recursive: true });
		assert.equal(findAgentsMdInParents(nested), join(root, "AGENTS.md"));
	}));

	it("prefers the nearest file when several exist", () => withTree((root) => {
		writeFileSync(join(root, "AGENTS.md"), "# outer");
		const nested = join(root, "inner");
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(nested, "AGENTS.md"), "# inner");
		assert.equal(findAgentsMdInParents(nested), join(nested, "AGENTS.md"));
	}));
});

describe("sanitizeAgentsContent", () => {
	it("remaps the pi home directory", () => {
		assert.equal(sanitizeAgentsContent("see ~/.pi/agent/skills"), "see ~/.claude/agent/skills");
	});

	it("remaps project-local pi paths", () => {
		assert.equal(sanitizeAgentsContent("config in .pi/settings.json"), "config in .claude/settings.json");
	});

	it("rewrites the bare product name so instructions still read correctly", () => {
		assert.equal(sanitizeAgentsContent("run pi to start"), "run environment to start");
	});

	it("leaves words merely containing 'pi' alone", () => {
		const out = sanitizeAgentsContent("the pipeline is happy");
		assert.equal(out, "the pipeline is happy");
	});

	it("applies path rules before the bare-word rule", () => {
		assert.equal(sanitizeAgentsContent("~/.pi and pi"), "~/.claude and environment");
	});
});

describe("extractAgentsAppend", () => {
	it("wraps content under a CLAUDE.md heading", () => withTree((root) => {
		writeFileSync(join(root, "AGENTS.md"), "Always run tests.");
		assert.equal(extractAgentsAppend(root), "# CLAUDE.md\n\nAlways run tests.");
	}));

	it("sanitizes while extracting", () => withTree((root) => {
		writeFileSync(join(root, "AGENTS.md"), "Config lives in ~/.pi/agent.");
		assert.match(extractAgentsAppend(root) ?? "", /~\/\.claude\/agent/);
	}));

	it("returns undefined for an empty file", () => withTree((root) => {
		writeFileSync(join(root, "AGENTS.md"), "   \n  ");
		assert.equal(extractAgentsAppend(root), undefined);
	}));
});
