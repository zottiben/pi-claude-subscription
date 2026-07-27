// Extension entry point.
//
// Registers two things:
//   1. The claude-subscription provider — Claude models usable directly in pi, with every
//      tool call flowing back through pi's TUI.
//   2. The AskClaude tool — available when some other provider is active, for delegating
//      a question or task to Claude Code.
//
// Everything below is wiring; the behaviour lives in provider.ts, stream.ts,
// session-sync.ts, tool-bridge.ts and ask-claude.ts.

import { getModels } from "@earendil-works/pi-ai/compat";
import { compact, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskClaudeTool } from "./ask-claude.js";
import { loadConfig } from "./config.js";
import { PROVIDER_BASE_URL, PROVIDER_ID } from "./constants.js";
import { debug, errorMessage } from "./debug.js";
import { applyLongContext, buildModels } from "./models.js";
import {
	isolatedStreamFn,
	reinjectPriorCompactionFileOps,
	setAskClaudeToolName,
	streamClaudeAgentSdk,
} from "./provider.js";
import { clearSharedSession, markNeedsRebuild } from "./session-sync.js";
import { getLongContextSettings, setProviderSettings, setUI } from "./runtime.js";

/**
 * Guard against registering the provider twice.
 *
 * Extensions such as pi-subagents spawn a subagent, which loads this module again. Without
 * the guard, the subagent's registerProvider would overwrite the parent's `streamSimple`
 * reference in the shared ModelRegistry — so when the parent later delivered a tool result
 * it would call the subagent's function, which has none of the parent's query state.
 *
 * Storing the active function under a Symbol.for() key (shared across every module
 * instance in the process) means only the first instance to register wins. Later instances
 * skip registration entirely and reach the models through the same registry.
 *
 * clearSession() resets this on session_shutdown, including /reload, so the next session
 * can register afresh.
 */
const ACTIVE_STREAM_SIMPLE_KEY = Symbol.for("claude-subscription:activeStreamSimple");

type StreamSimpleGlobal = Record<symbol, unknown>;

const MODELS = buildModels(getModels("anthropic"));

export default function activate(pi: ExtensionAPI): void {
	// Claude Code phones home for update checks, the MCP registry and telemetry. None of
	// that is wanted for a subprocess pi is driving.
	process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

	const config = loadConfig(process.cwd());
	debug("loadConfig:", JSON.stringify(config));
	setProviderSettings(config.provider ?? {});
	const registeredModels = applyLongContext(MODELS, getLongContextSettings());

	// --- Session lifecycle ---

	const clearSession = (event: string) => {
		debug(`${event}: clearing shared session`);
		clearSharedSession();
		// Release the registration flag if this instance owns it, so /reload can register
		// fresh rather than wrapping stale state.
		const g = globalThis as StreamSimpleGlobal;
		if (g[ACTIVE_STREAM_SIMPLE_KEY] === streamClaudeAgentSdk) {
			debug(`${event}: clearing ACTIVE_STREAM_SIMPLE_KEY`);
			g[ACTIVE_STREAM_SIMPLE_KEY] = undefined;
		}
	};

	pi.on("session_start", (event, ctx) => {
		setUI(ctx.ui);
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			clearSession(`session_start:${event.reason}`);
		}
	});
	pi.on("session_shutdown", () => clearSession("session_shutdown"));

	// Both pi's /compact and session-tree navigation (rewind, fork-at-point, branch switch)
	// mutate pi's messages array underneath us. Without forcing a rebuild, the REUSE check
	// would see no missed messages and keep resuming a Claude Code session that no longer
	// matches pi's history — and /compact in particular then trips Claude Code's own
	// autocompact-thrashing guard.
	pi.on("session_compact", (event) => markNeedsRebuild(`session_compact:${event.reason}:willRetry=${event.willRetry}`));
	pi.on("session_tree", () => markNeedsRebuild("session_tree"));

	// --- Compaction takeover ---
	//
	// Only for our own models; anything else keeps pi's native compaction.
	pi.on("session_before_compact", async (event, ctx) => {
		if (ctx.model?.baseUrl !== PROVIDER_BASE_URL) return undefined;
		debug(
			`session_before_compact: takeover reason=${event.reason} willRetry=${event.willRetry} ` +
			`isSplitTurn=${event.preparation.isSplitTurn} messages=${event.preparation.messagesToSummarize.length} ` +
			`turnPrefix=${event.preparation.turnPrefixMessages.length}`,
		);
		try {
			reinjectPriorCompactionFileOps(event.branchEntries, event.preparation);
			const compaction = await compact(
				event.preparation,
				ctx.model,
				undefined, // apiKey — the Claude Code subprocess owns auth
				undefined, // headers
				event.customInstructions,
				event.signal,
				undefined, // thinkingLevel
				isolatedStreamFn,
				undefined, // env
			);
			debug(`session_before_compact: takeover complete summaryLen=${compaction.summary.length}`);
			return { compaction };
		} catch (err) {
			// Cancel rather than fall through: pi's native compaction can't drive a Claude
			// Code model and is known to hang trying.
			const msg = errorMessage(err);
			debug("session_before_compact: takeover failed; cancelling to avoid native compact fallback", err);
			ctx.ui?.notify?.(
				`claude-subscription compact failed (${msg}); cancelled to avoid a known hang. Retry, switch model, or reduce context.`,
				"error",
			);
			return { cancel: true };
		}
	});

	// --- Provider ---

	const g = globalThis as StreamSimpleGlobal;
	if (!g[ACTIVE_STREAM_SIMPLE_KEY]) {
		g[ACTIVE_STREAM_SIMPLE_KEY] = streamClaudeAgentSdk;
		pi.registerProvider(PROVIDER_ID, {
			baseUrl: PROVIDER_BASE_URL,
			apiKey: "not-used", // auth is the Claude Code subprocess's problem, not ours
			api: PROVIDER_ID,
			models: registeredModels,
			streamSimple: streamClaudeAgentSdk,
		});
	} else {
		// Subagent session: the parent's registration already exposes these models through
		// the shared ModelRegistry, and calls route to the parent's streamSimple, which
		// handles them as reentrant queries.
		debug("provider: skipping re-registration, parent instance active");
	}

	// --- AskClaude tool ---

	setAskClaudeToolName(registerAskClaudeTool(pi, config.askClaude, MODELS));
}
