// Pure pi -> Anthropic message conversion.
// Kept separate from index.ts so tests can import without activating the extension.

import type { ImageContent, Message as PiMessage, TextContent } from "@earendil-works/pi-ai";
import type { ContentBlock, Message as SessionMessage } from "cc-session-io";
import { pascalCase } from "change-case";
import { PROVIDER_ID } from "./constants.js";

export const PI_TO_SDK_TOOL_NAME: Record<string, string> = {
	read: "Read", write: "Write", edit: "Edit", bash: "Bash",
};

/** Anthropic rejects tool ids outside [a-zA-Z0-9_-]. Other providers (Kimi, GLM) emit
 *  ids like `functions.bash:0`, so rewrite them — memoised in `cache` so the tool_use
 *  and its matching tool_result always land on the same replacement. */
export function sanitizeToolId(id: string, cache: Map<string, string>): string {
	const existing = cache.get(id);
	if (existing !== undefined) return existing;
	const clean = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	cache.set(id, clean);
	return clean;
}

export function mapPiToolNameToSdk(name: string, customToolNameToSdk?: Map<string, string>): string {
	if (!name) return "";
	const normalized = name.toLowerCase();
	if (customToolNameToSdk) {
		const mapped = customToolNameToSdk.get(name) ?? customToolNameToSdk.get(normalized);
		if (mapped) return mapped;
	}
	return PI_TO_SDK_TOOL_NAME[normalized] ?? pascalCase(name);
}

/** Minimal structural shape shared by pi content blocks and the loosely-typed blocks
 *  that reach us from other providers' session history. */
export interface LooseContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

/** Flatten mixed content to plain text. Returns "" when there was no text at all,
 *  letting callers distinguish "no text" from "empty text". */
export function messageContentToText(content: string | readonly LooseContentBlock[]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	let hasText = false;
	for (const block of content) {
		if (block.type === "text" && block.text) {
			parts.push(block.text);
			hasText = true;
		} else if (block.type !== "text" && block.type !== "image") {
			parts.push(`[${block.type}]`);
		}
	}
	return hasText ? parts.join("\n") : "";
}

/**
 * Whether a message's thinking signature was issued by Anthropic and can therefore be
 * replayed to the API.
 *
 * Checked on both axes because they carry different values: `provider` is an id like
 * "anthropic" (or our own PROVIDER_ID for turns this extension produced), while `api` is
 * the wire protocol, "anthropic-messages". Testing only one of them silently drops valid
 * thinking blocks from the other.
 */
export function isAnthropicAuthored(provider: string | undefined, api: string | undefined): boolean {
	return provider === PROVIDER_ID || provider === "anthropic" || api === "anthropic-messages";
}

function userContentBlocks(content: readonly (TextContent | ImageContent)[]): ContentBlock[] {
	const parts: ContentBlock[] = [];
	for (const block of content) {
		if (block.type === "text" && block.text) {
			parts.push({ type: "text", text: block.text });
		} else if (block.type === "image" && block.data && block.mimeType) {
			parts.push({ type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } });
		}
	}
	return parts;
}

/**
 * Convert a pi message array to Anthropic API format for session import.
 *
 * Lossy by design: thinking blocks without a valid Anthropic signature are dropped
 * (the API rejects unsigned ones), and only text/image/toolCall blocks are handled.
 * An assistant message whose blocks are all filtered out is replaced with a
 * placeholder rather than dropped, so tool_use/tool_result pairing survives.
 */
export function convertPiMessages(
	messages: readonly PiMessage[],
	customToolNameToSdk?: Map<string, string>,
): { anthropicMessages: SessionMessage[]; sanitizedIds: Map<string, string> } {
	const anthropicMessages: SessionMessage[] = [];
	const sanitizedIds = new Map<string, string>();

	for (const msg of messages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				anthropicMessages.push({ role: "user", content: msg.content || "[empty]" });
			} else if (Array.isArray(msg.content)) {
				const parts = userContentBlocks(msg.content);
				anthropicMessages.push({ role: "user", content: parts.length ? parts : "[image]" });
			} else {
				anthropicMessages.push({ role: "user", content: "[empty]" });
			}
		} else if (msg.role === "assistant") {
			const content = Array.isArray(msg.content) ? msg.content : [];
			const blocks: ContentBlock[] = [];
			for (const block of content) {
				if (block.type === "text" && block.text) {
					blocks.push({ type: "text", text: block.text });
				} else if (block.type === "thinking") {
					// Only Anthropic-issued signatures round-trip; the API rejects anything else.
					const signature = block.thinkingSignature;
					if (signature && isAnthropicAuthored(msg.provider, msg.api)) {
						blocks.push({ type: "thinking", thinking: block.thinking ?? "", signature });
					}
				} else if (block.type === "toolCall") {
					blocks.push({
						type: "tool_use",
						id: sanitizeToolId(block.id, sanitizedIds),
						name: mapPiToolNameToSdk(block.name, customToolNameToSdk),
						input: block.arguments ?? {},
					});
				}
			}
			if (!blocks.length) blocks.push({ type: "text", text: "[incompatible content omitted]" });
			anthropicMessages.push({ role: "assistant", content: blocks });
		} else if (msg.role === "toolResult") {
			const text = typeof msg.content === "string" ? msg.content : messageContentToText(msg.content);
			anthropicMessages.push({
				role: "user",
				content: [{
					type: "tool_result",
					tool_use_id: sanitizeToolId(msg.toolCallId, sanitizedIds),
					content: text || "",
					is_error: msg.isError,
				}],
			});
		}
	}

	return { anthropicMessages, sanitizedIds };
}
