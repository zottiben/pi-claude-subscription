// Status-line rendering helpers for the AskClaude tool.
//
// While Claude Code runs inside an AskClaude call the pi TUI can't surface each
// tool_use individually — there is one status row for the whole delegation. These
// helpers shape a tool_use record into a short, path-aware label ("Read(src/foo.ts)",
// "Bash(git log --oneline…)") and collapse consecutive calls to the same tool so the
// line doesn't flicker. Only promptAndWait uses this; the provider path renders tools
// through pi's TUI directly.

export interface ToolCallState {
	name: string;
	status: string;
	rawInput?: unknown;
}

const MAX_COMMAND_CHARS = 80;
const MAX_ARG_CHARS = 40;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function stringField(rawInput: unknown, key: string, maxChars = MAX_ARG_CHARS): string {
	const value = asRecord(rawInput)?.[key];
	return typeof value === "string" ? value.slice(0, maxChars) : "";
}

export function extractPath(rawInput: unknown): string | undefined {
	const input = asRecord(rawInput);
	if (!input) return undefined;
	if (typeof input.file_path === "string") return input.file_path;
	if (typeof input.path === "string") return input.path;
	if (typeof input.command === "string") return input.command.substring(0, MAX_COMMAND_CHARS);
	return undefined;
}

/** Shorten for display: strip the cwd prefix, else keep the last two segments. */
export function shortPath(p: string): string {
	const cwd = process.cwd();
	if (p.startsWith(cwd + "/")) return p.slice(cwd.length + 1);
	if (p.startsWith("/")) {
		const parts = p.split("/");
		if (parts.length > 3) return parts.slice(-2).join("/");
	}
	return p;
}

interface TodoItem {
	status?: string;
	content?: string;
}

function activeTodoLabel(rawInput: unknown): string | undefined {
	const todos = asRecord(rawInput)?.todos;
	if (!Array.isArray(todos)) return undefined;
	const items = todos as TodoItem[];
	const current = items.find((t) => t?.status === "in_progress") ?? items.find((t) => t?.status === "pending");
	const label = current ? String(current.content ?? "").slice(0, MAX_ARG_CHARS) : "";
	return label || undefined;
}

/** Returns undefined for tools that shouldn't appear in the summary at all. */
export function formatToolAction(tc: ToolCallState): string | undefined {
	const path = extractPath(tc.rawInput);
	const verb = tc.name.toLowerCase().split(/\s/)[0] ?? "";

	switch (verb) {
		case "read": case "readfile":
			return path ? `Read(${shortPath(path)})` : "Read";
		case "glob": {
			const pattern = stringField(tc.rawInput, "pattern");
			return pattern ? `Glob(${pattern})` : "Glob";
		}
		case "grep": {
			const pattern = stringField(tc.rawInput, "pattern");
			return pattern ? `Grep(${pattern})` : "Grep";
		}
		case "edit": case "write": case "writefile": case "multiedit":
			return path ? `Edit(${shortPath(path)})` : "Edit";
		case "bashoutput":
			return undefined; // redundant with the preceding Bash call
		case "bash": case "terminal":
			return path ? `Bash(${path})` : "Bash";
		case "agent":
			return `Agent(${stringField(tc.rawInput, "description")})`;
		case "skill": {
			const name = stringField(tc.rawInput, "skill");
			return name ? `Skill(${name})` : "Skill";
		}
		case "todowrite": case "taskcreate": case "taskupdate":
			return activeTodoLabel(tc.rawInput);
		case "askclaude":
			return undefined; // recursive — don't show AskClaude inside its own summary
		default:
			return tc.name;
	}
}

export function buildActionSummary(calls: ReadonlyMap<string, ToolCallState>): string {
	const parts: string[] = [];
	let prevVerb = "";
	for (const tc of calls.values()) {
		const action = formatToolAction(tc);
		if (!action) continue;
		const verb = tc.name.toLowerCase().split(/\s/)[0] ?? "";
		// Collapse consecutive calls to the same tool — keep only the latest
		if (verb === prevVerb && parts.length > 0) {
			parts[parts.length - 1] = action;
		} else {
			parts.push(action);
		}
		prevVerb = verb;
	}
	return parts.join("; ");
}
