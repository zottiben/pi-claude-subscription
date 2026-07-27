// Keeping Claude Code's session JSONL in step with pi's message history.
//
// Pi owns the conversation; Claude Code needs to see it as one of its own resumable
// sessions. Two semantic paths:
//
//   REUSE   — pi's history matches the session we already wrote (or drifted only by the
//             trailing assistant message pi appends after streamSimple returns, which
//             Claude Code's own persisted session already contains). Returns the existing
//             session id, keeping Claude Code's prompt cache warm.
//   REBUILD — no session yet, or pi's history diverged (a non-trailing gap, e.g. another
//             provider took a turn). Wipes the session file and writes a fresh one
//             covering all prior messages.
//
// Why rebuild rather than patch: injecting deltas into an existing session creates a
// branch that Claude Code's --resume does not follow. A complete overwrite at the same
// path is both simpler and correct.
//
// Why reuse the session id across rebuilds: Claude Code re-reads the JSONL on every
// --resume with no in-process UUID caching, so preserving the id keeps log correlation
// stable across provider switches and leaves no orphaned session files.
//
// The "Case 1/2/3/4" log strings are load-bearing for diagnostics — integration tests and
// bug reports grep for them. Keep them stable.

import { createSession, deleteSession, repairToolPairing, type Session } from "cc-session-io";
import type { Context } from "@earendil-works/pi-ai";
import { ISSUES_URL, LOG_PREFIX } from "./constants.js";
import { convertPiMessages } from "./convert.js";
import { DEBUG, DEBUG_LOG_PATH, debug, debugSessionPaths, diagDump, safeRealpath } from "./debug.js";
import { notify } from "./runtime.js";
import { verifyWrittenSession as verifyWrittenSessionPure } from "./session-verify.js";

export interface SessionState {
	sessionId: string;
	/** Number of pi messages already represented in the session file. */
	cursor: number;
	cwd: string;
	/**
	 * Force the next sync down the REBUILD path. Set when pi mutated its messages array
	 * out from under us (compaction, session-tree navigation), or after an abort left the
	 * JSONL in an indeterminate state.
	 */
	needsRebuild?: boolean;
	/**
	 * Set ONLY after an abort. The killed Claude Code subprocess may still be flushing a
	 * late "[Request interrupted by user]" record to the session JSONL. Reusing the same
	 * id and path would race that orphan write into our fresh file and break the
	 * parent-uuid chain on the next resume. When set, REBUILD takes a fresh UUID and skips
	 * deleteSession, so the orphan write lands on a dead inode.
	 *
	 * Compaction and tree navigation do NOT set this — there is no concurrent Claude Code
	 * writer during those, so an in-place rebuild is safe.
	 */
	forceRotate?: boolean;
}

export interface SyncResult {
	sessionId: string | null;
	preserveSharedSession?: boolean;
}

let sharedSession: SessionState | null = null;

export function getSharedSession(): SessionState | null {
	return sharedSession;
}

export function setSharedSession(state: SessionState | null): void {
	sharedSession = state;
}

export function clearSharedSession(): void {
	sharedSession = null;
}

/** Advance the cursor without otherwise disturbing the session. No-op when there is none. */
export function setSharedSessionCursor(cursor: number): void {
	if (sharedSession) sharedSession.cursor = cursor;
}

/** Mark the session for rebuild on the next sync, optionally rotating its id (post-abort). */
export function markNeedsRebuild(reason: string, options?: { forceRotate?: boolean }): void {
	if (!sharedSession) return;
	debug(`${reason}: marking needsRebuild${options?.forceRotate ? " + forceRotate" : ""} on session ${sharedSession.sessionId.slice(0, 8)}`);
	sharedSession = {
		...sharedSession,
		needsRebuild: true,
		...(options?.forceRotate ? { forceRotate: true } : {}),
	};
}

function convertAndImportMessages(
	session: Session,
	messages: Context["messages"],
	customToolNameToSdk?: Map<string, string>,
): void {
	const { anthropicMessages, sanitizedIds } = convertPiMessages(messages, customToolNameToSdk);

	debug(`convertAndImportMessages: ${messages.length} pi msgs → ${anthropicMessages.length} anthropic msgs`);
	debug("convertAndImportMessages: imported roles:", anthropicMessages.map((m, i) => {
		const c = m.content;
		if (typeof c === "string") return `[${i}]${m.role}:text`;
		return `[${i}]${m.role}:${c.map((b) => b.type).join("+")}`;
	}).join(" "));
	if (sanitizedIds.size > 0) {
		debug(`convertAndImportMessages: sanitized ${sanitizedIds.size} tool IDs:`,
			[...sanitizedIds.entries()].map(([orig, clean]) => orig === clean ? orig : `${orig}→${clean}`).join(", "));
	}

	// Pre-repair purely so the delta is visible in the log; importMessages repairs
	// internally too, and the operation is idempotent.
	const repaired = repairToolPairing(anthropicMessages);
	if (repaired.length !== anthropicMessages.length) {
		debug(`convertAndImportMessages: repairToolPairing ${anthropicMessages.length} → ${repaired.length} msgs`);
	}
	if (repaired.length) session.importMessages(repaired);
}

/**
 * Read back the session file we just wrote and sanity-check it.
 *
 * Warns rather than throws: Claude Code may well tolerate a file these checks flag, and
 * a false positive shouldn't block the user's turn. Each warning fans out to the debug
 * log, a pi notification, and a diagnostic dump.
 */
function verifyWrittenSession(
	jsonlPath: string,
	expectedSessionId: string,
	expectedRecordCount: number,
	cwd: string,
): void {
	const warnings = verifyWrittenSessionPure(jsonlPath, expectedSessionId, expectedRecordCount);
	for (const msg of warnings) {
		debug(`WARNING session verify: ${msg}`);
		notify(
			`Session file issue: ${msg}\n` +
			`cwd=${cwd} realpath=${safeRealpath(cwd)} CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "(unset)"}\n` +
			`Please copy this message into a new issue at ${ISSUES_URL}` +
			(DEBUG ? ` and attach ${DEBUG_LOG_PATH}` : ` (rerun with CLAUDE_SUBSCRIPTION_DEBUG=1 to capture a debug log)`),
			"warning",
		);
		diagDump("session_verify_fail", {
			msg,
			jsonlPath,
			cwd,
			realpath: safeRealpath(cwd),
			claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null,
		});
	}
}

/**
 * Ensure the shared session covers every message up to (but excluding) the latest user
 * prompt. Returns the session id to resume from, or null when Claude Code should start clean.
 */
export function syncSharedSession(
	messages: Context["messages"],
	cwd: string,
	customToolNameToSdk?: Map<string, string>,
	modelId?: string,
): SyncResult {
	const priorMessages = messages.slice(0, -1); // everything before the new user prompt

	// --- REUSE ---
	//
	// The `priorMessages.length >= cursor` guard is the general invariant for pi-side
	// history rewrites (/compact, session tree). Without it, a *shorter* incoming context
	// yields missed = [].slice(cursor) === [], which would falsely hit REUSE and resume an
	// unrelated, longer Claude Code session.
	if (sharedSession && !sharedSession.needsRebuild && priorMessages.length >= sharedSession.cursor) {
		const missed = priorMessages.slice(sharedSession.cursor);
		const trailingAssistantOnly = missed.length === 1 && missed[0]?.role === "assistant";
		if (missed.length === 0 || trailingAssistantOnly) {
			if (trailingAssistantOnly) {
				sharedSession = { ...sharedSession, cursor: priorMessages.length, cwd };
			}
			debug(`Case 3: ${trailingAssistantOnly ? "advanced cursor past trailing assistant, " : ""}resuming session ${sharedSession.sessionId.slice(0, 8)}, cursor=${sharedSession.cursor}`);
			debug(`syncResult: path=reuse sessionId=${sharedSession.sessionId} cursor=${sharedSession.cursor}`);
			return { sessionId: sharedSession.sessionId };
		}
	}

	// Shorter context with no pending rebuild. User-facing history rewrites always set
	// needsRebuild or clear the session first, so in practice this fires only for the
	// isolated compact-summary subprocess, which must not disturb the real session.
	if (sharedSession && !sharedSession.needsRebuild && priorMessages.length < sharedSession.cursor) {
		debug(`Case 1 synthetic: clean start for shorter context, preserving shared session ${sharedSession.sessionId.slice(0, 8)}, cursor=${sharedSession.cursor}`);
		debug(`syncResult: path=clean-start preserve-shared sessionId=${sharedSession.sessionId} cursor=${sharedSession.cursor}`);
		return { sessionId: null, preserveSharedSession: true };
	}

	// --- REBUILD ---
	if (priorMessages.length === 0) {
		debug(`Case 1: clean start, ${messages.length} total messages`);
		debug("syncResult: path=clean-start");
		return { sessionId: null };
	}

	const previousSessionId = sharedSession?.sessionId;
	const previousCursor = sharedSession?.cursor ?? 0;
	// Rebuild in place (delete + recreate with the same UUID) unless there's a concurrent
	// writer we shouldn't race — see forceRotate.
	const preserveId = previousSessionId !== undefined && !sharedSession?.forceRotate;
	if (preserveId && previousSessionId !== undefined) {
		// Wipe the prior jsonl and its companion dir; a no-op if there's nothing to wipe.
		deleteSession(previousSessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
	}

	const session = createSession({
		projectPath: cwd,
		claudeDir: process.env.CLAUDE_CONFIG_DIR,
		...(preserveId && previousSessionId !== undefined ? { sessionId: previousSessionId } : {}),
		...(modelId ? { model: modelId } : {}),
	});
	convertAndImportMessages(session, priorMessages, customToolNameToSdk);
	session.save();
	verifyWrittenSession(session.jsonlPath, session.sessionId, session.messages.length, cwd);
	sharedSession = { sessionId: session.sessionId, cursor: priorMessages.length, cwd };

	if (previousSessionId === undefined) {
		debug(`Case 2: first turn with ${priorMessages.length} prior messages → session ${session.sessionId.slice(0, 8)}, ${session.messages.length} records`);
	} else if (preserveId) {
		const missedCount = priorMessages.length - previousCursor;
		debug(`Case 4: ${missedCount} missed messages, ${priorMessages.length} total → rewrote session ${session.sessionId.slice(0, 8)} (same id), ${session.messages.length} records`);
	} else {
		debug(`Case 4 post-abort: ${priorMessages.length} total → new session ${session.sessionId.slice(0, 8)} (was ${previousSessionId.slice(0, 8)}, rotated to avoid racing an orphan writer), ${session.messages.length} records`);
	}
	debugSessionPaths(session.sessionId.slice(0, 8), cwd, session.jsonlPath);
	debug(`syncResult: path=rebuild sessionId=${session.sessionId} priors=${priorMessages.length} ${previousSessionId === undefined ? "first" : preserveId ? "preserved" : "rotated-post-abort"}`);
	return { sessionId: session.sessionId };
}

/** Drop the ephemeral session a preserve-shared query created, so it doesn't linger on disk. */
export function discardEphemeralSession(sessionId: string, cwd: string): void {
	deleteSession(sessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
	debug(`${LOG_PREFIX}: deleted ephemeral session ${sessionId.slice(0, 8)} to preserve shared session`);
}
