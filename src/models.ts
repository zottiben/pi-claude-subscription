// Model catalogue: which Claude models the provider offers, in picker order, and
// what context window each actually gets from a Claude subscription.
// Kept separate from index.ts so tests can import without activating the extension.

import type { Api, Model } from "@earendil-works/pi-ai";

/** Canonical selection + display order for the model picker. `resolveModel` returns the
 *  first partial match, so `"opus"` resolves to the first opus entry listed here. */
export const MODEL_IDS_IN_ORDER = [
	"claude-fable-5",
	"claude-opus-4-8",
	"claude-opus-4-7",
	"claude-opus-4-6",
	"claude-sonnet-5",
	"claude-sonnet-4-6",
	"claude-haiku-4-5",
] as const;

// Workaround for missing thinkingLevelMap in pi-ai (earendil-works/pi#6371).
// Sonnet 5 and Sonnet 4.6 ship no map, so getSupportedThinkingLevels hides xhigh
// (it's opt-in). Both models' top effort tier is "max" with no distinct xhigh
// (verified against the Claude Code supportedModels API), so xhigh->max matches opus-4-6.
const DEFAULT_THINKING_LEVEL_MAPS: Record<string, Model<Api>["thinkingLevelMap"]> = {
	"claude-sonnet-5": { xhigh: "max" },
	"claude-sonnet-4-6": { xhigh: "max" },
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
 * preserving MODEL_IDS_IN_ORDER ordering. IDs absent from pi-ai are silently dropped
 * so a pi-ai downgrade degrades to a shorter list rather than a crash.
 *
 * Cost is zeroed: these models bill against a Claude subscription, not per-token.
 * Context-dependent display labels are applied later by `applyLongContext`, once
 * the plan config is known.
 */
export function buildModels(piAiModels: readonly SourceModel[]): BridgedModel[] {
	const bridged: BridgedModel[] = [];
	for (const id of MODEL_IDS_IN_ORDER) {
		const model = piAiModels.find((m) => m.id === id);
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

export const TWO_HUNDRED_K_CONTEXT = 200_000;
export const ONE_M_CONTEXT = 1_000_000;

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

export function resolveModel<T extends { id: string }>(models: readonly T[], input: string): T | undefined {
	const lower = input.toLowerCase();
	return models.find((m) => m.id === lower || m.id.includes(lower));
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
