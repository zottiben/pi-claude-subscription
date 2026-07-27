// AGENTS.md discovery and sanitisation for forwarding to Claude Code.
//
// Pi keeps long-lived instructions in AGENTS.md; Claude Code reads equivalent content
// under "# CLAUDE.md". We walk up from cwd looking for AGENTS.md, fall back to
// ~/.pi/agent/AGENTS.md, and rewrite pi-specific references (~/.pi, .pi/, "pi") so any
// paths mentioned in the file still resolve inside the Claude Code subprocess.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const AGENTS_FILE_NAME = "AGENTS.md";

function globalAgentsPath(): string {
	return join(homedir(), ".pi", "agent", AGENTS_FILE_NAME);
}

export function findAgentsMdInParents(startDir: string): string | undefined {
	let current = resolve(startDir);
	for (;;) {
		const candidate = join(current, AGENTS_FILE_NAME);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

export function resolveAgentsMdPath(cwd: string = process.cwd()): string | undefined {
	const fromCwd = findAgentsMdInParents(cwd);
	if (fromCwd) return fromCwd;
	const global = globalAgentsPath();
	return existsSync(global) ? global : undefined;
}

export function extractAgentsAppend(cwd: string = process.cwd()): string | undefined {
	const agentsPath = resolveAgentsMdPath(cwd);
	if (!agentsPath) return undefined;
	try {
		const content = readFileSync(agentsPath, "utf-8").trim();
		if (!content) return undefined;
		const sanitized = sanitizeAgentsContent(content);
		return sanitized.length > 0 ? `# CLAUDE.md\n\n${sanitized}` : undefined;
	} catch {
		return undefined;
	}
}

/** Rewrite pi-isms so instructions still make sense inside Claude Code. Order matters:
 *  the path rules must run before the bare-word rule, or "pi" inside ".pi/" is mangled first. */
export function sanitizeAgentsContent(content: string): string {
	return content
		.replace(/~\/\.pi\b/gi, "~/.claude")
		.replace(/(^|[\s'"`])\.pi\//g, "$1.claude/")
		.replace(/\b\.pi\b/gi, ".claude")
		.replace(/\bpi\b/gi, "environment");
}
