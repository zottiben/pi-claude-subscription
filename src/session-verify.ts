// Pure session-file integrity check. Returns warning strings; callers decide how to
// surface them (debug log, pi notification, diagnostic dump).
//
// This is a sanity check on a file we just wrote, not a validator for Claude Code's
// own format — Claude Code may well accept files this flags, which is why every finding
// is a warning rather than a thrown error.
// Kept separate from index.ts so tests can import without activating the extension.

import { readFileSync, statSync } from "node:fs";

function describeError(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

export function verifyWrittenSession(
	jsonlPath: string,
	expectedSessionId: string,
	expectedRecordCount: number,
): string[] {
	const warnings: string[] = [];

	let size: number;
	try {
		size = statSync(jsonlPath).size;
	} catch (e) {
		warnings.push(`file missing after save — path=${jsonlPath} err=${describeError(e)}`);
		return warnings;
	}

	let content: string;
	try {
		content = readFileSync(jsonlPath, "utf8");
	} catch (e) {
		warnings.push(`file unreadable — path=${jsonlPath} size=${size} err=${describeError(e)}`);
		return warnings;
	}

	const lines = content.split("\n").filter((l) => l.trim().length > 0);
	if (lines.length !== expectedRecordCount) {
		warnings.push(`record count mismatch — expected=${expectedRecordCount} actual=${lines.length} path=${jsonlPath} bytes=${content.length}`);
		return warnings;
	}

	const first = lines[0];
	const last = lines[lines.length - 1];
	if (first === undefined || last === undefined) return warnings;

	try {
		const firstRec = JSON.parse(first) as { sessionId?: string };
		const lastRec = JSON.parse(last) as { sessionId?: string };
		if (firstRec.sessionId !== expectedSessionId || lastRec.sessionId !== expectedSessionId) {
			warnings.push(`sessionId drift — expected=${expectedSessionId} first=${firstRec.sessionId} last=${lastRec.sessionId}`);
		}
	} catch (e) {
		warnings.push(`malformed JSONL — path=${jsonlPath} err=${describeError(e)}`);
	}

	return warnings;
}
