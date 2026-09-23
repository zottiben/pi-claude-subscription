// Model catalogue: which Claude models the provider offers, in picker order, and
// what context window each actually gets from a Claude subscription.
// Kept separate from index.ts so tests can import without activating the extension.

import type { Api, Model } from "@earendil-works/pi-ai";

/** Canonical selection + display order for the model picker. Failing an exact id match,
 *  `resolveModel` returns the first partial match, so `"opus"` resolves to the first opus
 *  entry listed here and `"fable"` to the first fable entry. */
export const MODEL_IDS_IN_ORDER = [
	"claude-opus-5-5",
	"claude-opus-5",
	"claude-fable-5-1",
	"claude-fable-5",
	"claude-opus-4-8",
	"claude-opus-4-7",
	"claude-opus-4-6",
	"claude-sonnet-5",
	"claude-sonnet-4-6",
	"claude-haiku-4-5",
] as const;

export const TWO_HUNDRED_K_CONTEXT = 200_000;
export const ONE_M_CONTEXT = 1_000_000;

// Workaround for missing thinkingLevelMap in pi-ai (earendil-works/pi#6371).
// Sonnet 5 and Sonnet 4.6 ship no map, so getSupportedThinkingLevels hides xhigh
// (it's opt-in). Both models' top effort tier is "max" with no distinct xhigh
// (verified against the Claude Code supportedModels API), so xhigh->max matches opus-4-6.
const DEFAULT_THINKING_LEVEL_MAPS: Record<string, Model<Api>["thinkingLevelMap"]> = {
	"claude-sonnet-5": { xhigh: "max" },
	"claude-sonnet-4-6": { xhigh: "max" },
};

/**
 * Catalogue entries for models Claude Code serves but pi-ai has not shipped yet.
 *
 * `buildModels` drops unknown ids, so without this a model released between pi-ai versions
 * would be invisible here no matter what the rest of this file says. pi-ai's own entry wins
 * as soon as it exists.
 *
 * Fields mirror pi-ai's entries, corrected against the published model specs. Keep a
 * fallback until this package's minimum supported pi-ai version contains the model, not
 * merely until the latest pi-ai does, or older compatible Pi installs silently lose it.
 */
const PI_AI_FALLBACK_MODELS: Record<string, SourceModel> = {
	"claude-opus-5-5": {
		id: "claude-opus-5-5",
		name: "Claude Opus 5.5",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: ONE_M_CONTEXT,
		maxTokens: 128_000,
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
	},
	"claude-fable-5-1": {
		id: "claude-fable-5-1",
		name: "Claude Fable 5.1",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: ONE_M_CONTEXT,
		maxTokens: 128_000,
		thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
	},
};

/** The subset of a pi-ai model entry this module reads, with pi-ai's own field types. */
export type SourceModel = Pick<
	Model<Api>,
	"id" | "name" | "reasoning" | "input" | "contextWindow" | "maxTokens" | "thinkingLevelMap"
>;

/** A catalogue entry ready to hand to pi's registerProvider. Structurally a
 *  ProviderModelConfig minus the fields the provider itself supplies. */
export interface BridgedModel extends SourceModel {
	cost: Model<Api>["cost"];
}

/**
 * Project pi-ai's model entries down to the fields pi's registerProvider expects,
 * preserving MODEL_IDS_IN_ORDER ordering. IDs absent from both pi-ai and
 * PI_AI_FALLBACK_MODELS are silently dropped so a pi-ai downgrade degrades to a shorter
 * list rather than a crash.
 *
 * Cost is zeroed: these models bill against a Claude subscription, not per-token.
 * Context-dependent display labels are applied later by `applyLongContext`, once
 * the plan config is known.
 */
export function buildModels(piAiModels: readonly SourceModel[]): BridgedModel[] {
	const bridged: BridgedModel[] = [];
	for (const id of MODEL_IDS_IN_ORDER) {
		const model = piAiModels.find((m) => m.id === id) ?? PI_AI_FALLBACK_MODELS[id];
		if (!model) continue;
		bridged.push({
			id: model.id,
			name: model.name,
			reasoning: model.reasoning,
			input: model.input,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			// Forward pi-ai's per-model map when present (e.g. opus-4-7 maps xhigh->xhigh,
			// not xhigh->max) so the effort lookup in index.ts sees the override.
			thinkingLevelMap: model.thinkingLevelMap ?? DEFAULT_THINKING_LEVEL_MAPS[model.id],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	}
	return bridged;
}

export interface LongContextSettings {
	plan: "pro" | "max";
	longContextExtraUsage: boolean;
}

export interface ClaudeCodeRuntimeModel {
	cliModelId: string;
	contextWindow: number;
}

/**
 * Maximum output Claude Code reserves when it serves each model.
 *
 * Pi's fixed 16K default compaction reserve is smaller than every value here. The provider
 * uses this measured budget to report threshold pressure before Claude Code rejects an
 * internal tool-result turn for lacking output room. Keep it in sync with
 * `diag/context-size.ts`; unknown models conservatively use up to 64K.
 */
export function claudeCodeMaxOutputTokens(model: Pick<SourceModel, "id" | "maxTokens">): number {
	switch (model.id) {
		case "claude-opus-5-5":
			return Math.min(model.maxTokens, 128_000);
		case "claude-sonnet-4-6":
		case "claude-haiku-4-5":
			return Math.min(model.maxTokens, 32_000);
		default:
			return Math.min(model.maxTokens, 64_000);
	}
}

/**
 * Measured Claude Agent SDK subscription/OAuth behaviour.
 *
 * Do not infer this from pi-ai's advertised contextWindow: bare Opus 4.7 serves 1M,
 * bare Opus 4.8 does not, and the `[1m]` entitlement differs per model and per plan.
 * Unknown ids warn and fall back to 200K rather than throwing, so a newly released
 * model still works (just without long context) until this table is updated.
 */
export function resolveClaudeCodeRuntimeModel(modelId: string, settings: LongContextSettings): ClaudeCodeRuntimeModel {
	switch (modelId) {
		// Opus 5.5 has a native 1M window in Anthropic's published specification: 1M is both
		// the default and the maximum, so unlike entitlement-dependent models it needs no suffix.
		case "claude-opus-5-5":
			return { cliModelId: "claude-opus-5-5", contextWindow: ONE_M_CONTEXT };
		// Measured 1M both bare and with [1m], no rejection. The suffix is kept because it
		// requests 1M explicitly rather than depending on a default entitlement, and that
		// default has already changed once (see diag/CONTEXT-SIZE.md).
		case "claude-opus-5":
			return { cliModelId: "claude-opus-5[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-opus-4-8":
			return { cliModelId: "claude-opus-4-8[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-opus-4-7":
			return { cliModelId: "claude-opus-4-7", contextWindow: ONE_M_CONTEXT };
		case "claude-opus-4-6": {
			const useOneM = settings.plan === "max" || settings.longContextExtraUsage;
			return {
				cliModelId: useOneM ? "claude-opus-4-6[1m]" : "claude-opus-4-6",
				contextWindow: useOneM ? ONE_M_CONTEXT : TWO_HUNDRED_K_CONTEXT,
			};
		}
		// Measured 1M both bare and with [1m], no rejection, same as Opus 5. The suffix is kept
		// for the same reason: it requests 1M explicitly rather than trusting a default.
		case "claude-fable-5-1":
			return { cliModelId: "claude-fable-5-1[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-fable-5":
			return { cliModelId: "claude-fable-5[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-sonnet-5":
			return { cliModelId: "claude-sonnet-5[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-sonnet-4-6":
			return {
				cliModelId: settings.longContextExtraUsage ? "claude-sonnet-4-6[1m]" : "claude-sonnet-4-6",
				contextWindow: settings.longContextExtraUsage ? ONE_M_CONTEXT : TWO_HUNDRED_K_CONTEXT,
			};
		case "claude-haiku-4-5":
			return { cliModelId: "claude-haiku-4-5", contextWindow: TWO_HUNDRED_K_CONTEXT };
		default:
			console.error(`claude-subscription: model ${modelId} has no known context size, defaulting to 200K`);
			return { cliModelId: modelId, contextWindow: TWO_HUNDRED_K_CONTEXT };
	}
}

export function claudeCodeModelId(model: { id: string }, settings: LongContextSettings): string {
	return resolveClaudeCodeRuntimeModel(model.id, settings).cliModelId;
}

/**
 * Resolve a user-supplied model name: an exact id anywhere in the list wins, otherwise the
 * first partial match in picker order.
 *
 * Exact match is checked across the whole list first because ids are not prefix-free:
 * `claude-fable-5` is a prefix of `claude-fable-5-1`, which sorts earlier, so a positional
 * check would answer an explicit request for Fable 5 with Fable 5.1.
 */
export function resolveModel<T extends { id: string }>(models: readonly T[], input: string): T | undefined {
	const lower = input.toLowerCase();
	return models.find((m) => m.id === lower) ?? models.find((m) => m.id.includes(lower));
}

/**
 * Finalise the metadata registered with pi. The registered contextWindow must match the
 * window the extension actually requests from Claude Code, or pi's status bar and
 * auto-compaction threshold will both misreport.
 */
export function applyLongContext<T extends { id: string; name: string; contextWindow?: number | null }>(
	models: readonly T[],
	settings: LongContextSettings,
): T[] {
	return models.map((m) => {
		const { contextWindow } = resolveClaudeCodeRuntimeModel(m.id, settings);
		const name = contextWindow > TWO_HUNDRED_K_CONTEXT && !/\b1M\b/i.test(m.name) ? `${m.name} 1M` : m.name;
		return contextWindow === m.contextWindow && name === m.name ? m : { ...m, contextWindow, name };
	});
}
