// Tool-result extraction: walks the context tail to collect this turn's tool results.
//
// Pi never hands the provider a tool result directly — it appends the result to the
// context and calls the provider again. This scrapes them back out. The walk skips
// user messages (steer/followUp that pi can inject between tool results) and stops at
// the nearest assistant message, which is the turn boundary.
// Kept separate from index.ts so tests can import without activating the extension.

export type McpContent = Array<
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
>;

export interface McpResult {
	content: McpContent;
	isError?: boolean;
	toolCallId?: string;
	[key: string]: unknown;
}

interface LooseBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

/** Message shape as it reaches us from pi's context — deliberately loose, since the walk
 *  runs over history that may have been produced by any provider. Structural on purpose:
 *  pi's own Message union satisfies it without a cast. */
export interface LooseMessage {
	role: string;
	content?: unknown;
	toolCallId?: string;
	isError?: boolean;
}

export function toolResultToMcpContent(content: unknown): McpContent {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) return [{ type: "text", text: "" }];
	const blocks: McpContent = [];
	for (const block of content as LooseBlock[]) {
		if (block.type === "text" && block.text) {
			blocks.push({ type: "text", text: block.text });
		} else if (block.type === "image" && block.data && block.mimeType) {
			blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
		}
	}
	return blocks.length ? blocks : [{ type: "text", text: "" }];
}

/** Returns `stopIdx` alongside the results so callers can log where the walk stopped
 *  (-1 means it ran to the start of the context without hitting an assistant message). */
export function extractAllToolResults(
	messages: readonly LooseMessage[],
): { results: McpResult[]; stopIdx: number } {
	const results: McpResult[] = [];
	let stopIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg === undefined) continue;
		if (msg.role === "toolResult") {
			results.unshift({
				content: toolResultToMcpContent(msg.content),
				isError: msg.isError,
				toolCallId: msg.toolCallId,
			});
		} else if (msg.role === "assistant") {
			stopIdx = i;
			break;
		}
		// user messages: skip — steer/followUp injected mid tool execution
	}
	return { results, stopIdx };
}
