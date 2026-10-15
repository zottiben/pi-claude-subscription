// Unit tests for the context pressure reported to Pi.
//
// Claude Code owns max-output selection. Pi's default compaction reserve is only 16,384
// tokens, so reporting raw usage lets a model with a much larger output budget reach a
// point where its next internal tool turn is rejected before Pi compacts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { updateUsage } from "../../src/stream.js";
import type { BridgeModel } from "../../src/types.js";

const model: BridgeModel = {
	id: "claude-opus-5-5",
	name: "Claude Opus 5.5 1M",
	api: "claude-subscription",
	provider: "claude-subscription",
	baseUrl: "claude-code://subscription",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
};

function output() {
	return {
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

describe("updateUsage context pressure", () => {
	it("forces threshold compaction before Opus 5.5 exhausts its 128K output headroom", () => {
		const turn = output();
		updateUsage(turn, {
			input_tokens: 2,
			output_tokens: 7_516,
			cache_read_input_tokens: 972_191,
			cache_creation_input_tokens: 1_280,
		}, model);

		assert.equal(2 + 7_516 + 972_191 + 1_280, 980_989, "fixture matches the observed overflow turn");
		assert.ok(turn.usage.totalTokens > model.contextWindow - 16_384, "Pi should compact before another Claude turn");
	});

	for (const id of ["claude-sonnet-5-5", "claude-haiku-5-5"]) {
		it(`signals pressure at the 128K output boundary for ${id}`, () => {
			const turn = output();
			const newModel = { ...model, id };
			updateUsage(turn, { input_tokens: 870_000, output_tokens: 1_000 }, newModel);
			assert.equal(turn.usage.totalTokens, 871_000, "raw usage is preserved below the boundary");
			updateUsage(turn, { input_tokens: 879_000, output_tokens: 1_000 }, newModel);
			assert.ok(turn.usage.totalTokens > model.contextWindow - 16_384, "128K, not 64K, must remain for output");
		});
	}

	it("keeps raw usage unchanged while there is enough output headroom", () => {
		const turn = output();
		updateUsage(turn, {
			input_tokens: 2,
			output_tokens: 1_000,
			cache_read_input_tokens: 100_000,
			cache_creation_input_tokens: 500,
		}, model);

		assert.equal(turn.usage.totalTokens, 101_502);
	});
});
