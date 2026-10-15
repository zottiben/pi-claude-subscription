// Unit tests for the compaction takeover's prompt extraction.
//
// Pi builds the summarization request with normalizeContext(), which folds the
// summarization system prompt into a leading system message rather than leaving it in a
// separate field. The extractor has to see through that: getting it wrong throws before
// the Claude Code subprocess is even spawned, and index.ts turns any throw here into
// `{ cancel: true }` — so a session that needs compacting can never compact again.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	getCurrentTools,
	normalizeContext,
	type AssistantMessage,
	type Message,
} from "@earendil-works/pi-ai";
import { compact } from "@earendil-works/pi-coding-agent";
import { buildModels } from "../../src/models.js";
import type { BridgeModel } from "../../src/types.js";
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

describe("Pi compaction API compatibility", () => {
	for (const isSplitTurn of [false, true]) {
		it(`passes ${isSplitTurn ? "split-turn" : "ordinary"} summaries through the takeover extractor`, async () => {
			const source = buildModels([]).find((model) => model.id === "claude-haiku-5-5");
			assert.ok(source);
			const model: BridgeModel = {
				...source,
				api: "claude-subscription",
				provider: "claude-subscription",
				baseUrl: "claude-code://subscription",
			};
			const preparation: Parameters<typeof compact>[0] = {
				firstKeptEntryId: "kept-entry",
				messagesToSummarize: [{ role: "user", content: "HISTORY_MARKER", timestamp: 0 }],
				turnPrefixMessages: isSplitTurn ? [{ role: "user", content: "TURN_MARKER", timestamp: 1 }] : [],
				isSplitTurn,
				tokensBefore: 100_000,
				fileOps: { read: new Set(["read.ts"]), edited: new Set(["edited.ts"]), written: new Set() },
				settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
			};
			const signal = new AbortController().signal;
			const prompts: string[] = [];
			const result = await compact(preparation, model, undefined, undefined, undefined, signal, undefined,
				(_model, context, options) => {
					prompts.push(extractIsolatedSummaryPrompt(context.messages));
					assert.ok(getCurrentSystemPrompt(context.messages));
					assert.deepEqual(getCurrentTools(context.messages), []);
					assert.equal(options?.signal, signal);
					const message: AssistantMessage = {
						role: "assistant",
						content: [{ type: "text", text: `Summary ${prompts.length}` }],
						api: model.api, provider: model.provider, model: model.id,
						usage: {
							input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop", timestamp: 0,
					};
					const stream = createAssistantMessageEventStream();
					stream.push({ type: "done", reason: "stop", message });
					stream.end();
					return stream;
				});

			assert.equal(prompts.length, isSplitTurn ? 2 : 1);
			assert.match(prompts[0], /HISTORY_MARKER/);
			if (isSplitTurn) {
				assert.match(prompts[1], /TURN_MARKER/);
				assert.match(result.summary, /Summary 2/);
			}
			assert.match(result.summary, /Summary 1/);
			assert.equal(result.firstKeptEntryId, preparation.firstKeptEntryId);
			assert.equal(result.tokensBefore, preparation.tokensBefore);
			assert.deepEqual(result.details, { readFiles: ["read.ts"], modifiedFiles: ["edited.ts"] });
		});
	}
});

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
