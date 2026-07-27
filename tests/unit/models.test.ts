// Unit tests for the model catalogue and the long-context policy.
//
// The runtime table encodes measured Claude subscription behaviour, so these tests are
// the guard against someone "tidying" it into something that looks more consistent but
// no longer matches what the API actually serves.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyLongContext,
	buildModels,
	claudeCodeModelId,
	MODEL_IDS_IN_ORDER,
	ONE_M_CONTEXT,
	resolveClaudeCodeRuntimeModel,
	resolveModel,
	TWO_HUNDRED_K_CONTEXT,
	type LongContextSettings,
	type SourceModel,
} from "../../src/models.js";

const PRO: LongContextSettings = { plan: "pro", longContextExtraUsage: false };
const MAX: LongContextSettings = { plan: "max", longContextExtraUsage: false };
const PRO_EXTRA: LongContextSettings = { plan: "pro", longContextExtraUsage: true };

function source(id: string, overrides: Partial<SourceModel> = {}): SourceModel {
	return {
		id,
		name: id,
		reasoning: true,
		input: ["text", "image"],
		contextWindow: TWO_HUNDRED_K_CONTEXT,
		maxTokens: 64_000,
		...overrides,
	};
}

describe("buildModels", () => {
	it("preserves MODEL_IDS_IN_ORDER regardless of input order", () => {
		const shuffled = [...MODEL_IDS_IN_ORDER].reverse().map((id) => source(id));
		assert.deepEqual(buildModels(shuffled).map((m) => m.id), [...MODEL_IDS_IN_ORDER]);
	});

	it("drops ids pi-ai doesn't know, instead of failing", () => {
		const built = buildModels([source("claude-opus-4-8"), source("some-future-model")]);
		assert.deepEqual(built.map((m) => m.id), ["claude-opus-4-8"]);
	});

	it("zeroes cost, since these bill against a subscription", () => {
		const built = buildModels([source("claude-opus-4-8")]);
		assert.deepEqual(built[0]?.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	it("supplies a fallback thinkingLevelMap for Sonnet, which pi-ai omits", () => {
		const built = buildModels([source("claude-sonnet-5"), source("claude-sonnet-4-6")]);
		assert.equal(built[0]?.thinkingLevelMap?.xhigh, "max");
		assert.equal(built[1]?.thinkingLevelMap?.xhigh, "max");
	});

	it("prefers pi-ai's own map over the fallback", () => {
		const built = buildModels([source("claude-sonnet-5", { thinkingLevelMap: { xhigh: "xhigh" } })]);
		assert.equal(built[0]?.thinkingLevelMap?.xhigh, "xhigh");
	});
});

describe("resolveClaudeCodeRuntimeModel", () => {
	it("gives Opus 5 1M on every plan, with no gating", () => {
		for (const settings of [PRO, MAX, PRO_EXTRA]) {
			assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-opus-5", settings), {
				cliModelId: "claude-opus-5[1m]", contextWindow: ONE_M_CONTEXT,
			});
		}
	});

	it("gives Opus 4.8 1M via an explicit [1m] suffix", () => {
		assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-opus-4-8", PRO), {
			cliModelId: "claude-opus-4-8[1m]", contextWindow: ONE_M_CONTEXT,
		});
	});

	it("gives Opus 4.7 1M with no suffix, because bare 4.7 already serves 1M", () => {
		assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-opus-4-7", PRO), {
			cliModelId: "claude-opus-4-7", contextWindow: ONE_M_CONTEXT,
		});
	});

	it("gates Opus 4.6 1M behind a Max plan or extra usage", () => {
		assert.equal(resolveClaudeCodeRuntimeModel("claude-opus-4-6", PRO).contextWindow, TWO_HUNDRED_K_CONTEXT);
		assert.equal(resolveClaudeCodeRuntimeModel("claude-opus-4-6", MAX).contextWindow, ONE_M_CONTEXT);
		assert.equal(resolveClaudeCodeRuntimeModel("claude-opus-4-6", PRO_EXTRA).contextWindow, ONE_M_CONTEXT);
	});

	it("gates Sonnet 4.6 1M behind extra usage only — a Max plan is not enough", () => {
		assert.equal(resolveClaudeCodeRuntimeModel("claude-sonnet-4-6", MAX).contextWindow, TWO_HUNDRED_K_CONTEXT);
		assert.equal(resolveClaudeCodeRuntimeModel("claude-sonnet-4-6", PRO_EXTRA).contextWindow, ONE_M_CONTEXT);
	});

	it("keeps Haiku at 200K on every plan", () => {
		for (const settings of [PRO, MAX, PRO_EXTRA]) {
			assert.equal(resolveClaudeCodeRuntimeModel("claude-haiku-4-5", settings).contextWindow, TWO_HUNDRED_K_CONTEXT);
		}
	});

	it("falls back to 200K for an unknown model rather than throwing", () => {
		const originalError = console.error;
		const seen: unknown[] = [];
		console.error = (...args: unknown[]) => { seen.push(args); };
		try {
			const resolved = resolveClaudeCodeRuntimeModel("claude-opus-9-9", PRO);
			assert.deepEqual(resolved, { cliModelId: "claude-opus-9-9", contextWindow: TWO_HUNDRED_K_CONTEXT });
			assert.equal(seen.length, 1, "should warn about the unknown model");
		} finally {
			console.error = originalError;
		}
	});
});

describe("claudeCodeModelId", () => {
	it("returns the CLI id, suffix included", () => {
		assert.equal(claudeCodeModelId({ id: "claude-sonnet-5" }, PRO), "claude-sonnet-5[1m]");
	});
});

describe("applyLongContext", () => {
	it("aligns the registered window with what the extension will actually request", () => {
		const models = buildModels([source("claude-opus-4-6")]);
		assert.equal(applyLongContext(models, MAX)[0]?.contextWindow, ONE_M_CONTEXT);
		assert.equal(applyLongContext(models, PRO)[0]?.contextWindow, TWO_HUNDRED_K_CONTEXT);
	});

	it("appends a 1M label so the picker shows what you get", () => {
		const models = buildModels([source("claude-opus-4-6", { name: "Claude Opus 4.6" })]);
		assert.equal(applyLongContext(models, MAX)[0]?.name, "Claude Opus 4.6 1M");
		assert.equal(applyLongContext(models, PRO)[0]?.name, "Claude Opus 4.6");
	});

	it("does not double up a 1M label the name already carries", () => {
		const models = buildModels([source("claude-opus-4-8", { name: "Claude Opus 4.8 1M" })]);
		assert.equal(applyLongContext(models, PRO)[0]?.name, "Claude Opus 4.8 1M");
	});

	it("returns the identical object when nothing changed", () => {
		const models = buildModels([source("claude-haiku-4-5")]);
		assert.equal(applyLongContext(models, PRO)[0], models[0]);
	});
});

describe("resolveModel", () => {
	const models = MODEL_IDS_IN_ORDER.map((id) => ({ id }));

	// AskClaudeCode defaults to model "opus", so this decides what a plain delegation gets.
	it("resolves a bare family name to the first entry in picker order", () => {
		assert.equal(resolveModel(models, "opus")?.id, "claude-opus-5");
		assert.equal(resolveModel(models, "sonnet")?.id, "claude-sonnet-5");
	});

	it("still resolves an explicit older id", () => {
		assert.equal(resolveModel(models, "claude-opus-4-8")?.id, "claude-opus-4-8");
		assert.equal(resolveModel(models, "opus-4-7")?.id, "claude-opus-4-7");
	});

	it("matches an exact id case-insensitively", () => {
		assert.equal(resolveModel(models, "CLAUDE-HAIKU-4-5")?.id, "claude-haiku-4-5");
	});

	it("returns undefined when nothing matches", () => {
		assert.equal(resolveModel(models, "gpt-5"), undefined);
	});
});
