// The AskClaude tool: delegate a question or task to Claude Code from another provider.
//
// This is the mirror image of the provider. Where the provider makes Claude Code drive
// pi's tools, AskClaude lets a non-Claude model hand work to Claude Code and wait for the
// answer. Claude Code runs with its own tools here (subject to the mode gate), so there's
// no MCP bridge — just a status line summarising what it did.

import { query, type EffortLevel, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { StringEnum, type Context } from "@earendil-works/pi-ai";
import { buildSessionContext, convertToLlm, keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { buildActionSummary, type ToolCallState } from "./askclaude-ui.js";
import type { AskClaudeConfig, AskClaudeMode } from "./config.js";
import { PROVIDER_BASE_URL } from "./constants.js";
import { debug, errorMessage, makeCliDebugOptions } from "./debug.js";
import { claudeCodeModelId, resolveModel } from "./models.js";
import { REASONING_TO_EFFORT } from "./provider.js";
import { getLongContextSettings, getProviderSettings } from "./runtime.js";
import { getSharedSession, syncSharedSession } from "./session-sync.js";
import { extractSkillsBlock } from "./skills.js";
import { mapToolName } from "./tool-bridge.js";

/** All this module needs from a catalogue entry: enough to resolve a name to a CLI model id. */
type ModelRef = { id: string };

/**
 * Claude Code tools blocked per AskClaude mode.
 *
 * MAINTENANCE: review this after every Claude Code release. New agentic tools that
 * shouldn't be reachable from a delegated subagent belong in the appropriate list.
 *
 * The always-blocked set is about capability, not safety: these tools need a human at a
 * TUI that the delegated subagent doesn't have. Other agentic tools (Agent, SendMessage,
 * Tasks) are deliberately left available.
 */
const ALWAYS_BLOCKED = [
	"AskUserQuestion", "EnterPlanMode", "ExitPlanMode",
	"ToolSearch",     // probes for blocked tools and burns tokens doing it
	"ScheduleWakeup", // nothing would fire the wakeup inside a delegated subagent
];

export const MODE_DISALLOWED_TOOLS: Record<AskClaudeMode, string[]> = {
	full: [
		...ALWAYS_BLOCKED,
	],
	read: [
		...ALWAYS_BLOCKED,
		"Write", "Edit", "Bash", "NotebookEdit",
		"EnterWorktree", "ExitWorktree", "CronCreate", "CronDelete", "TeamCreate", "TeamDelete",
	],
	none: [
		...ALWAYS_BLOCKED,
		"Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent",
		"NotebookEdit", "EnterWorktree", "ExitWorktree",
		"CronCreate", "CronDelete", "TeamCreate", "TeamDelete",
		"WebFetch", "WebSearch",
	],
};

const DEFAULT_TOOL_DESCRIPTION_FULL = "Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories), or to autonomously handle a task. Defaults to read-only mode — use full mode when the user wants to delegate a task that requires changes. Prefer to handle straightforward tasks yourself.";
const DEFAULT_TOOL_DESCRIPTION = "Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories). Read-only — Claude Code can explore the codebase but not make changes. Prefer to handle straightforward tasks yourself.";

/**
 * Default pi-side name for the tool.
 *
 * Deliberately not the bare "AskClaude": pi refuses to load an extension whose tool name
 * collides with one already registered, and pi-claude-bridge (which this project derives
 * from) registers "AskClaude". A collision doesn't degrade gracefully — it hard-fails
 * extension loading, so installing this alongside the bridge would break the whole
 * session. Set `askClaude.name` to "AskClaude" once the bridge is gone if you prefer it.
 */
export const DEFAULT_TOOL_NAME = "AskClaudeCode";

const PREVIEW_MAX_CHARS = 1000;
const PREVIEW_MAX_LINES = 6;
const PROGRESS_TICK_MS = 1000;

export interface PromptAndWaitOptions {
	systemPrompt?: string;
	appendSkills?: boolean;
	onStreamUpdate?: (responseText: string) => void;
	model?: string;
	thinking?: string;
	isolated?: boolean;
	context?: Context["messages"];
}

export interface PromptAndWaitResult {
	responseText: string;
	stopReason: string;
}

/** Run one Claude Code delegation to completion, streaming text back through onStreamUpdate. */
export async function promptAndWait(
	models: readonly ModelRef[],
	prompt: string,
	mode: AskClaudeMode,
	toolCalls: Map<string, ToolCallState>,
	signal?: AbortSignal,
	options?: PromptAndWaitOptions,
): Promise<PromptAndWaitResult> {
	const cwd = process.cwd();
	const requestedModel = options?.model ?? "opus";
	const model = resolveModel(models, requestedModel);
	const modelId = model?.id ?? requestedModel;
	const cliModel = model ? claudeCodeModelId(model, getLongContextSettings()) : modelId;

	// Shared (non-isolated) mode reuses the provider's session when one exists, otherwise
	// builds one from pi's context so Claude Code sees the conversation so far.
	//
	// Note: this doesn't advance sharedSession.cursor afterwards, so the next provider call
	// sees missed messages and rebuilds (Case 4). That's intentional — Claude Code appended
	// its own records here, and a rebuild is the cheap way to get back in sync.
	let resumeSessionId: string | null = null;
	if (!options?.isolated && options?.context?.length) {
		const shared = getSharedSession();
		if (shared) {
			resumeSessionId = shared.sessionId;
		} else {
			const contextWithPrompt = [
				...options.context,
				{ role: "user" as const, content: prompt, timestamp: Date.now() },
			];
			resumeSessionId = syncSharedSession(contextWithPrompt, cwd, undefined, modelId).sessionId;
		}
	}

	const disallowedTools = MODE_DISALLOWED_TOOLS[mode] ?? [];
	const skillsBlock = options?.appendSkills !== false && options?.systemPrompt
		? extractSkillsBlock(options.systemPrompt)
		: undefined;
	const effort: EffortLevel | undefined = options?.thinking && options.thinking !== "off"
		? REASONING_TO_EFFORT[options.thinking]
		: undefined;
	const claudeExecutable = getProviderSettings().pathToClaudeCodeExecutable;

	const extraArgs: Record<string, string | null> = { "strict-mcp-config": null, model: cliModel };
	if (effort) extraArgs["thinking-display"] = "summarized";

	debug("askClaude:",
		`mode=${mode} model=${modelId} cliModel=${cliModel} effort=${effort ?? "default"}`,
		`isolated=${options?.isolated ?? false} resume=${resumeSessionId?.slice(0, 8) ?? "none"}`,
		`skills=${Boolean(skillsBlock)} promptLen=${prompt.length}`);

	const sdkQuery = query({
		prompt,
		options: {
			cwd,
			env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "0", DISABLE_AUTO_COMPACT: "1" },
			permissionMode: "bypassPermissions",
			...(disallowedTools.length ? { disallowedTools } : {}),
			...(effort ? { effort } : {}),
			systemPrompt: skillsBlock ? { type: "preset", preset: "claude_code", append: skillsBlock } : undefined,
			settingSources: ["user", "project"] as SettingSource[],
			extraArgs,
			...(resumeSessionId ? { resume: resumeSessionId } : {}),
			...(options?.isolated ? { persistSession: false } : {}),
			...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
			...makeCliDebugOptions("askclaude"),
		},
	});

	let wasAborted = false;
	const onAbort = () => {
		wasAborted = true;
		sdkQuery.interrupt().catch(() => {
			try { sdkQuery.close(); } catch { /* already closed */ }
		});
	};
	if (signal?.aborted) {
		onAbort();
		throw new Error("Aborted");
	}
	signal?.addEventListener("abort", onAbort, { once: true });

	let responseText = "";
	let sdkMessageCount = 0;
	let textDeltaCount = 0;
	let resultSubtype: string | undefined;

	try {
		for await (const message of sdkQuery) {
			if (wasAborted) break;
			sdkMessageCount++;

			if (message.type === "stream_event") {
				const event = message.event;
				if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
					responseText += event.delta.text;
					textDeltaCount++;
					options?.onStreamUpdate?.(responseText);
				} else if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
					debug(`askClaude: tool_use start: ${event.content_block.name}`);
					toolCalls.set(event.content_block.id, {
						name: mapToolName(event.content_block.name),
						status: "running",
					});
				}
			} else if (message.type === "assistant") {
				// Re-record with the full input now that the arguments are complete.
				for (const block of message.message.content ?? []) {
					if (block.type === "tool_use") {
						toolCalls.set(block.id, {
							name: mapToolName(block.name),
							status: "complete",
							rawInput: block.input,
						});
					}
				}
			} else if (message.type === "result") {
				resultSubtype = message.subtype;
				const usage = message.usage;
				if (usage) {
					debug(`askClaude: result usage: in=${usage.input_tokens} out=${usage.output_tokens} cacheRead=${usage.cache_read_input_tokens ?? 0} cacheWrite=${usage.cache_creation_input_tokens ?? 0} turns=${message.num_turns}`);
				}
				// No streamed text means the whole reply arrived in the result envelope.
				if (!responseText && message.subtype === "success" && message.result) {
					responseText = message.result;
				}
			}
		}

		const stopReason = wasAborted ? "cancelled" : "stop";
		debug("askClaude: done",
			`stopReason=${stopReason} resultSubtype=${resultSubtype ?? "none"}`,
			`sdkMessages=${sdkMessageCount} textDeltas=${textDeltaCount} responseLen=${responseText.length}`,
			`toolCalls=${toolCalls.size}`);
		return { responseText, stopReason };
	} finally {
		signal?.removeEventListener("abort", onAbort);
		sdkQuery.close();
	}
}

interface AskClaudeResultDetails {
	prompt?: string;
	executionTime?: number;
	actions?: string;
	error?: boolean;
}

/** Register the AskClaude tool, unless config disabled it. Returns the tool's name so the
 *  provider can exclude it from the MCP bridge. */
export function registerAskClaudeTool(
	pi: ExtensionAPI,
	config: AskClaudeConfig | undefined,
	models: readonly ModelRef[],
): string {
	const toolName = config?.name ?? DEFAULT_TOOL_NAME;
	if (config?.enabled === false) return toolName;

	const allowFull = config?.allowFullMode !== false;
	const defaultMode: AskClaudeMode = config?.defaultMode ?? "read";
	const defaultIsolated = config?.defaultIsolated ?? false;

	const modeValues = allowFull ? ["read", "full", "none"] as const : ["read", "none"] as const;
	let modeDesc = '"read" (default): questions about the codebase — review, analysis, explain. "none": general knowledge only (no file access).';
	if (allowFull) modeDesc += ' "full": allows writing and bash execution (careful: runs without feedback to pi).';

	const parameters = Type.Object({
		prompt: Type.String({ description: "The question or task for Claude Code. By default Claude sees the full conversation history. Don't research up front, let Claude explore." }),
		mode: Type.Optional(StringEnum(modeValues, { description: modeDesc })),
		model: Type.Optional(Type.String({ description: 'Claude model (e.g. "opus", "sonnet", "haiku", "fable", or full ID). Defaults to "opus".' })),
		thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, { description: "Thinking effort level. Omit to use Claude Code's default." })),
		isolated: Type.Optional(Type.Boolean({ description: "When true, Claude sees only this prompt (clean session). When false (default), Claude sees the full conversation history." })),
	});

	pi.registerTool<typeof parameters>({
		name: toolName,
		label: config?.label ?? "Ask Claude Code",
		description: config?.description ?? (allowFull ? DEFAULT_TOOL_DESCRIPTION_FULL : DEFAULT_TOOL_DESCRIPTION),
		parameters,

		renderCall(args, theme) {
			let text = theme.fg("mdLink", theme.bold(`${toolName} `));
			const mode = args.mode ?? defaultMode;
			const tags: string[] = [];
			if (mode !== defaultMode) tags.push(`mode=${mode}`);
			if (args.model) tags.push(`model=${args.model}`);
			if (args.thinking) tags.push(`thinking=${args.thinking}`);
			if (args.isolated) tags.push("isolated");
			if (tags.length) text += `${theme.fg("accent", `[${tags.join(", ")}]`)} `;

			const truncated = args.prompt.slice(0, PREVIEW_MAX_CHARS);
			const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
			text += theme.fg("muted", `"${lines.join("\n")}"`);
			if (args.prompt.length > PREVIEW_MAX_CHARS || args.prompt.split("\n").length > PREVIEW_MAX_LINES) {
				text += theme.fg("dim", " …");
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const first = result.content[0];
			if (isPartial) {
				const status = first?.type === "text" ? first.text : "working...";
				return new Text(theme.fg("mdLink", "◉ Claude Code ") + theme.fg("muted", status), 0, 0);
			}

			const details = result.details as AskClaudeResultDetails | undefined;
			const body = first?.type === "text" ? first.text : "";

			let text = details?.error
				? theme.fg("error", "✗ Claude Code error")
				: theme.fg("mdLink", "✓ Claude Code");
			if (details?.executionTime) text += ` ${theme.fg("dim", `${(details.executionTime / 1000).toFixed(1)}s`)}`;
			if (details?.actions) text += ` ${theme.fg("muted", details.actions)}`;

			if (expanded) {
				if (details?.prompt) text += `\n${theme.fg("dim", `Prompt: ${details.prompt}`)}`;
				if (details?.prompt && body) text += `\n${theme.fg("dim", "─".repeat(40))}`;
				if (body) text += `\n${theme.fg("toolOutput", body)}`;
			} else {
				const lines = body.slice(0, PREVIEW_MAX_CHARS).split("\n").slice(0, PREVIEW_MAX_LINES);
				if (lines.length) text += `\n${theme.fg("toolOutput", lines.join("\n"))}`;
				if (body.length > PREVIEW_MAX_CHARS || body.split("\n").length > PREVIEW_MAX_LINES) {
					text += `\n${theme.fg("dim", `… (${keyHint("app.tools.expand", "to expand")})`)}`;
				}
			}
			return new Text(text, 0, 0);
		},

		async execute(_id, params, signal, onUpdate, toolCtx) {
			// Delegating to Claude Code from a Claude Code model is a loop with extra steps.
			if (toolCtx.model?.baseUrl === PROVIDER_BASE_URL) {
				debug("askClaude: blocked circular delegation (active provider is claude-subscription)");
				return {
					content: [{ type: "text" as const, text: `Error: ${toolName} cannot be used when the active provider is claude-subscription — you're already running through Claude Code.` }],
					details: { error: true } satisfies AskClaudeResultDetails,
				};
			}

			const mode = (params.mode ?? defaultMode) as AskClaudeMode;
			const isolated = params.isolated ?? defaultIsolated;
			const toolCalls = new Map<string, ToolCallState>();
			const start = Date.now();

			const progressInterval = setInterval(() => {
				const elapsed = ((Date.now() - start) / 1000).toFixed(0);
				const summary = buildActionSummary(toolCalls);
				onUpdate?.({
					content: [{ type: "text", text: summary ? `${elapsed}s — ${summary}` : `${elapsed}s — working...` }],
					details: { prompt: params.prompt, executionTime: Date.now() - start },
				});
			}, PROGRESS_TICK_MS);

			try {
				const result = await promptAndWait(models, params.prompt, mode, toolCalls, signal, {
					systemPrompt: toolCtx.getSystemPrompt(),
					appendSkills: config?.appendSkills,
					model: params.model,
					thinking: params.thinking,
					isolated,
					// convertToLlm drops extension-authored custom messages, which have no
					// LLM representation, and leaves a plain user/assistant/toolResult history.
					context: isolated ? undefined : convertToLlm(buildSessionContext(toolCtx.sessionManager.getBranch()).messages),
				});
				clearInterval(progressInterval);
				onUpdate?.({ content: [{ type: "text", text: "" }], details: {} });

				const executionTime = Date.now() - start;
				const actions = buildActionSummary(toolCalls);
				const text = actions
					? `${result.responseText}\n\n[Claude Code actions: ${actions}]`
					: result.responseText;
				return {
					content: [{ type: "text" as const, text }],
					details: { prompt: params.prompt, executionTime, actions } satisfies AskClaudeResultDetails,
				};
			} catch (err) {
				clearInterval(progressInterval);
				debug(`askClaude error: mode=${mode}, model=${params.model ?? "default"}, isolated=${isolated}, elapsed=${((Date.now() - start) / 1000).toFixed(1)}s, error=`, err);
				return {
					content: [{ type: "text" as const, text: `Error: ${errorMessage(err)}` }],
					details: { prompt: params.prompt, executionTime: Date.now() - start, error: true } satisfies AskClaudeResultDetails,
				};
			}
		},
	});

	return toolName;
}
