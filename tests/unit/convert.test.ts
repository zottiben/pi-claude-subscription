// Unit tests for pi -> Anthropic message conversion.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Message as PiMessage } from "@earendil-works/pi-ai";
import type { ContentBlock, Message as SessionMessage } from "cc-session-io";
import {
	convertPiMessages,
	isAnthropicAuthored,
	mapPiToolNameToSdk,
	messageContentToText,
	sanitizeToolId,
} from "../../src/convert.js";

/** Convert and return just the Anthropic messages. */
function convert(messages: PiMessage[], customToolNameToSdk?: Map<string, string>): SessionMessage[] {
	return convertPiMessages(messages, customToolNameToSdk).anthropicMessages;
}

function blocks(msg: SessionMessage | undefined): ContentBlock[] {
	assert.ok(msg, "expected a message");
	assert.ok(Array.isArray(msg.content), "expected block content, got a string");
	return msg.content;
}

function assistant(content: PiMessage extends { role: "assistant" } ? never : unknown[]): PiMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-4-8",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 0,
	} as PiMessage;
}

function toolResult(toolCallId: string, content: string, isError = false): PiMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text: content }],
		isError,
		timestamp: 0,
	} as PiMessage;
}

describe("sanitizeToolId", () => {
	it("rewrites characters Anthropic rejects", () => {
		assert.equal(sanitizeToolId("functions.bash:0", new Map()), "functions_bash_0");
		assert.equal(sanitizeToolId("tool call#1@foo", new Map()), "tool_call_1_foo");
	});

	it("leaves already-valid ids untouched", () => {
		assert.equal(sanitizeToolId("toolu_abc123-XYZ", new Map()), "toolu_abc123-XYZ");
	});

	it("is stable for the same id, so a call and its result stay paired", () => {
		const cache = new Map<string, string>();
		assert.equal(sanitizeToolId("fn.read:0", cache), sanitizeToolId("fn.read:0", cache));
		assert.equal(cache.size, 1);
	});
});

describe("convertPiMessages tool pairing", () => {
	it("keeps tool_use and tool_result ids matched after sanitization", () => {
		const ids = ["fn.read:0", "fn.write:1", "fn.bash:2"];
		const msgs: PiMessage[] = [];
		for (const id of ids) {
			msgs.push(assistant([{ type: "toolCall", id, name: "bash", arguments: {} }]));
			msgs.push(toolResult(id, "ok"));
		}

		const result = convert(msgs);
		for (let i = 0; i < ids.length; i++) {
			const use = blocks(result[i * 2])[0];
			const res = blocks(result[i * 2 + 1])[0];
			assert.equal(use?.type, "tool_use");
			assert.equal(res?.type, "tool_result");
			if (use?.type === "tool_use" && res?.type === "tool_result") {
				assert.equal(use.id, res.tool_use_id, `pair ${i} must reference the same id`);
			}
		}
	});

	it("propagates the isError flag onto tool_result", () => {
		const result = convert([
			assistant([{ type: "toolCall", id: "t1", name: "bash", arguments: {} }]),
			toolResult("t1", "boom", true),
		]);
		const block = blocks(result[1])[0];
		assert.equal(block?.type, "tool_result");
		if (block?.type === "tool_result") assert.equal(block.is_error, true);
	});
});

describe("convertPiMessages thinking blocks", () => {
	it("keeps signed thinking from an Anthropic-family provider", () => {
		const result = convert([
			assistant([{ type: "thinking", thinking: "hmm", thinkingSignature: "sig-abc" }]),
		]);
		const block = blocks(result[0])[0];
		assert.equal(block?.type, "thinking");
	});

	// Regression: the provider id is "anthropic" but the api id is "anthropic-messages".
	// Matching only one of them drops valid signed thinking from the other.
	it("recognises Anthropic authorship from either the provider or the api field", () => {
		assert.equal(isAnthropicAuthored("anthropic", "anthropic-messages"), true);
		assert.equal(isAnthropicAuthored("anthropic", undefined), true);
		assert.equal(isAnthropicAuthored(undefined, "anthropic-messages"), true);
		assert.equal(isAnthropicAuthored("claude-subscription", "claude-subscription"), true);
		assert.equal(isAnthropicAuthored("openrouter", "openai-completions"), false);
	});

	it("keeps signed thinking when only the api field identifies Anthropic", () => {
		const msg = assistant([{ type: "thinking", thinking: "hmm", thinkingSignature: "sig-abc" }]);
		const result = convert([{ ...msg, provider: "some-proxy" } as PiMessage]);
		assert.equal(blocks(result[0])[0]?.type, "thinking");
	});

	it("drops unsigned thinking, which the API would reject", () => {
		const result = convert([
			assistant([{ type: "thinking", thinking: "hmm" }, { type: "text", text: "answer" }]),
		]);
		const kinds = blocks(result[0]).map((b) => b.type);
		assert.deepEqual(kinds, ["text"]);
	});

	it("substitutes a placeholder rather than emitting an empty assistant message", () => {
		const result = convert([assistant([{ type: "thinking", thinking: "hmm" }])]);
		const block = blocks(result[0])[0];
		assert.equal(block?.type, "text");
		if (block?.type === "text") assert.match(block.text, /incompatible content omitted/);
	});
});

describe("convertPiMessages user content", () => {
	it("passes string content straight through", () => {
		const result = convert([{ role: "user", content: "hello", timestamp: 0 }]);
		assert.equal(result[0]?.content, "hello");
	});

	it("substitutes a placeholder for empty content, since the API rejects it", () => {
		const result = convert([{ role: "user", content: "", timestamp: 0 }]);
		assert.equal(result[0]?.content, "[empty]");
	});

	it("converts images to base64 source blocks", () => {
		const result = convert([{
			role: "user",
			content: [{ type: "text", text: "look" }, { type: "image", data: "AAAA", mimeType: "image/png" }],
			timestamp: 0,
		}]);
		const imageBlock = blocks(result[0])[1];
		assert.equal(imageBlock?.type, "image");
		if (imageBlock?.type === "image" && imageBlock.source.type === "base64") {
			assert.equal(imageBlock.source.media_type, "image/png");
			assert.equal(imageBlock.source.data, "AAAA");
		}
	});
});

describe("mapPiToolNameToSdk", () => {
	it("maps pi built-ins to Claude Code names", () => {
		assert.equal(mapPiToolNameToSdk("read"), "Read");
		assert.equal(mapPiToolNameToSdk("bash"), "Bash");
	});

	it("prefers an explicit custom mapping", () => {
		const custom = new Map([["mytool", "mcp__custom-tools__mytool"]]);
		assert.equal(mapPiToolNameToSdk("mytool", custom), "mcp__custom-tools__mytool");
	});

	it("falls back to PascalCase for unknown names", () => {
		assert.equal(mapPiToolNameToSdk("web_search"), "WebSearch");
	});

	it("returns empty for an empty name", () => {
		assert.equal(mapPiToolNameToSdk(""), "");
	});
});

describe("messageContentToText", () => {
	it("joins text blocks with newlines", () => {
		assert.equal(messageContentToText([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "a\nb");
	});

	it("returns empty when there is no text at all", () => {
		assert.equal(messageContentToText([{ type: "image", data: "x", mimeType: "image/png" }]), "");
	});

	it("labels non-text, non-image blocks so they aren't silently lost", () => {
		assert.equal(messageContentToText([{ type: "text", text: "a" }, { type: "audio" }]), "a\n[audio]");
	});
});
