// Debug logging and diagnostics.
//
// Everything here is inert unless CLAUDE_SUBSCRIPTION_DEBUG=1, with one exception:
// diagDump always writes. That's deliberate — it's reserved for "should never happen"
// branches, and those are exactly the ones you can't ask a user to reproduce with a
// flag set.

import { appendFileSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	CLI_LOG_DIR_NAME,
	DEBUG_ENV_VAR,
	DEBUG_LOG_BASENAME,
	DEBUG_PATH_ENV_VAR,
	DIAG_LOG_BASENAME,
} from "./constants.js";

export const DEBUG = process.env[DEBUG_ENV_VAR] === "1";

const PI_AGENT_DIR = join(homedir(), ".pi", "agent");

export const DEBUG_LOG_PATH = process.env[DEBUG_PATH_ENV_VAR] || join(PI_AGENT_DIR, DEBUG_LOG_BASENAME);
export const DIAG_LOG_PATH = join(PI_AGENT_DIR, DIAG_LOG_BASENAME);

if (DEBUG) {
	try {
		mkdirSync(dirname(DEBUG_LOG_PATH), { recursive: true });
		mkdirSync(dirname(DIAG_LOG_PATH), { recursive: true });
	} catch {
		// Directory creation failed; the append below will surface it on first use.
	}
}

/**
 * Unique per module evaluation. Extensions that spawn subagents cause this module to be
 * loaded more than once in the same process; tagging every log line makes it obvious
 * which instance produced it, and whether module state is genuinely shared.
 */
export const moduleInstanceId = Math.random().toString(36).slice(2, 8);

function format(arg: unknown): string {
	if (typeof arg === "string") return arg;
	if (arg instanceof Error) return `${arg.name}: ${arg.message}${arg.stack ? "\n" + arg.stack : ""}`;
	try {
		return JSON.stringify(arg) ?? String(arg);
	} catch {
		return String(arg);
	}
}

export function debug(...args: unknown[]): void {
	if (!DEBUG) return;
	const ts = new Date().toISOString();
	appendFileSync(DEBUG_LOG_PATH, `[${ts}] [${moduleInstanceId}] ${args.map(format).join(" ")}\n`);
}

/** Unconditional diagnostic dump, for paths that should be unreachable. */
export function diagDump(label: string, data: Record<string, unknown>): void {
	const entry = { ts: new Date().toISOString(), moduleInstanceId, label, ...data };
	try {
		mkdirSync(dirname(DIAG_LOG_PATH), { recursive: true });
		appendFileSync(DIAG_LOG_PATH, JSON.stringify(entry) + "\n");
	} catch {
		// Never let diagnostics take down a turn.
	}
	debug(`DIAG: ${label} (see ${DIAG_LOG_PATH})`);
}

export interface CliDebugOptions {
	debug?: boolean;
	debugFile?: string;
	stderr?: (data: string) => void;
}

let nextCliDebugSeq = 1;

/**
 * Per-query Claude Code CLI debug capture.
 *
 * Asks the CLI subprocess to write its own debug log to a file we choose, and forwards
 * its stderr into our stream. Without this, Claude Code's internal view is invisible and
 * reports like "No conversation found" or an empty error are unactionable.
 */
export function makeCliDebugOptions(tag: string): CliDebugOptions {
	if (!DEBUG) return {};
	const seq = nextCliDebugSeq++;
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const logDir = join(dirname(DEBUG_LOG_PATH), CLI_LOG_DIR_NAME);
	try {
		mkdirSync(logDir, { recursive: true });
	} catch {
		// Fall through: the CLI will report if it can't write the file.
	}
	const debugFile = join(logDir, `${ts}-${tag}-${seq}.log`);
	debug(`cli-debug: ${tag} #${seq} → ${debugFile}`);
	return {
		debug: true,
		debugFile,
		stderr: (data: string) => {
			for (const line of data.split(/\r?\n/)) {
				if (line) debug(`[cli-stderr ${tag}#${seq}] ${line}`);
			}
		},
	};
}

export function safeRealpath(p: string): string {
	try {
		return realpathSync(p);
	} catch (e) {
		return `<failed: ${e instanceof Error ? e.message : String(e)}>`;
	}
}

/**
 * Snapshot where a session file was just written.
 *
 * Catches the class of bug where pi writes to ~/.claude/projects/<X> while the Claude
 * Code SDK reads from ~/.claude/projects/<Y> — symlinked cwd, CLAUDE_CONFIG_DIR set,
 * or a project-path hash mismatch.
 */
export function debugSessionPaths(label: string, cwd: string, jsonlPath: string): void {
	if (!DEBUG) return;
	const realCwd = safeRealpath(cwd);
	let fileExists = false;
	let fileSize: number | null = null;
	try {
		fileSize = statSync(jsonlPath).size;
		fileExists = true;
	} catch {
		// File may legitimately not exist yet.
	}
	debug(`${label}: cwd=${cwd}`);
	if (realCwd !== cwd) {
		debug(`${label}: realpath(cwd)=${realCwd} (DIFFERS — the symlink-resolved path is what the Claude Code SDK uses)`);
	}
	debug(`${label}: jsonlPath=${jsonlPath}`);
	debug(`${label}: fileExists=${fileExists}${fileSize != null ? ` size=${fileSize}` : ""}`);
	debug(`${label}: env.CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "(unset)"} HOME=${process.env.HOME ?? "(unset)"}`);
}

export function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (err && typeof err === "object") {
		const obj = err as Record<string, unknown>;
		if (typeof obj.message === "string") return obj.message;
		if (typeof obj.error === "string") return obj.error;
		try {
			return JSON.stringify(err) ?? String(err);
		} catch {
			return String(err);
		}
	}
	return String(err);
}
