// Unit tests for the compaction takeover's prompt extraction.
//
// Pi builds the summarization request with normalizeContext(), which folds the
// summarization system prompt into a leading system message rather than leaving it in a
// separate field. The extractor has to see through that: getting it wrong throws before
// the Claude Code subprocess is even spawned, and index.ts turns any throw here into
// `{ cancel: true }` — so a session that needs compacting can never compact again.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import {
	consumeCompactionContinuation,
	extractIsolatedSummaryPrompt,
	prepareForCompactionContinuation,
} from "../../src/provider.js";
import { ctx, resetContext } from "../../src/query-state.js";

const SUMMARY_SYSTEM_PROMPT = "You are a context summarization assistant.";

/** The transcript pi's buildSummarizationContext hands to the stream function. */
function summarizationMessages(promptText: string): Message[] {
	return normalizeContext({
		systemPrompt: SUMMARY_SYSTEM_PROMPT,
		messages: [{ role: "user", content: [{ type: "text", text: promptText }], timestamp: 0 }],
	}).messages;
}

describe("compaction continuation", () => {
	it("turns an overflow retry into exactly one fresh continuation", async () => {
		resetContext();
		await prepareForCompactionContinuation(true);

		assert.equal(consumeCompactionContinuation(), true);
		assert.equal(consumeCompactionContinuation(), false);
	});

	it("aborts an active query before continuing from a threshold compaction", async () => {
		resetContext();
		const queryCtx = ctx();
		let aborted = false;
		queryCtx.activeQuery = {} as never;
		queryCtx.abortActiveQuery = () => {
			aborted = true;
			queryCtx.activeQuery = null;
		};
		queryCtx.activeQueryCompletion = Promise.resolve();

		await prepareForCompactionContinuation(false);

		assert.equal(aborted, true);
		assert.equal(consumeCompactionContinuation(), true);
	});
});

describe("extractIsolatedSummaryPrompt", () => {
	it("reads the prompt past the normalized leading system message", () => {
		const messages = summarizationMessages("<conversation>\nhello\n</conversation>");
		assert.equal(messages.length, 2, "normalizeContext should prepend a system message");
		assert.equal(extractIsolatedSummaryPrompt(messages), "<conversation>\nhello\n</conversation>");
	});

	it("reads the prompt when there is no leading system message", () => {
		const messages: Message[] = [{ role: "user", content: "summarize this", timestamp: 0 }];
		assert.equal(extractIsolatedSummaryPrompt(messages), "summarize this");
	});

	it("rejects a transcript that is not a single summarization turn", () => {
		const messages: Message[] = [
			{ role: "user", content: "first", timestamp: 0 },
			{ role: "user", content: "second", timestamp: 0 },
		];
		assert.throws(() => extractIsolatedSummaryPrompt(messages), /expected exactly 1 user message, got 2/);
	});

	it("rejects an empty prompt", () => {
		assert.throws(() => extractIsolatedSummaryPrompt(summarizationMessages("")), /prompt is empty/);
	});
});
