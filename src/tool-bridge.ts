// Bridging pi's tools into Claude Code, and its tool calls back out.
//
// Claude Code never executes pi's tools itself. Instead every pi tool is exposed over an
// in-process MCP server whose handlers block on a promise; pi runs the tool for real and
// the result is delivered back through the provider, unblocking the handler. That's what
// keeps tool execution, permissions, and rendering inside pi's TUI.

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { getCurrentTools, type JsonObject, type Tool, type TranscriptContext } from "@earendil-works/pi-ai";
import { debug } from "./debug.js";
import type { McpResult } from "./extract-tool-results.js";
import type { QueryContext } from "./query-state.js";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX } from "./skills.js";
import { jsonSchemaToZodShape } from "./typebox-to-zod.js";

/** Claude Code's built-in tool names mapped to pi's equivalents. */
const SDK_TO_PI_TOOL_NAME: Record<string, string> = {
	read: "read", write: "write", edit: "edit", bash: "bash",
};

/**
 * Claude Code SDK parameter names that differ from pi's.
 * Keys not listed pass straight through, so new pi parameters work with no change here.
 */
const SDK_KEY_RENAMES: Record<string, Record<string, string>> = {
	read: { file_path: "path" },
	write: { file_path: "path" },
	edit: {
		file_path: "path",
		old_string: "oldText", new_string: "newText",
		old_text: "oldText", new_text: "newText",
	},
};

/** Pi's bash tool has no default timeout; Claude Code's is 120s. Match it. */
const DEFAULT_BASH_TIMEOUT_SECONDS = 120;

export function mapToolName(name: string, customToolNameToPi?: Map<string, string>): string {
	const normalized = name.toLowerCase();
	const builtin = SDK_TO_PI_TOOL_NAME[normalized];
	if (builtin) return builtin;
	if (customToolNameToPi) {
		const mapped = customToolNameToPi.get(name) ?? customToolNameToPi.get(normalized);
		if (mapped) return mapped;
	}
	if (normalized.startsWith(MCP_TOOL_PREFIX)) return name.slice(MCP_TOOL_PREFIX.length);
	return name;
}

/**
 * Translate SDK tool arguments into pi's parameter names.
 *
 * Renaming plus pass-through only — pi's own prepareArguments hooks handle structural
 * transforms (such as edit's oldText/newText becoming an edits[] array).
 */
export function mapToolArgs(
	toolName: string,
	args: JsonObject | undefined,
): JsonObject {
	const input = args ?? {};
	const renames = SDK_KEY_RENAMES[toolName.toLowerCase()];
	const result: JsonObject = {};
	for (const [key, value] of Object.entries(input)) {
		const piKey = renames?.[key] ?? key;
		if (!(piKey in result)) result[piKey] = value; // first alias wins
	}
	if (toolName.toLowerCase() === "bash" && result.timeout == null) {
		result.timeout = DEFAULT_BASH_TIMEOUT_SECONDS;
	}
	return result;
}

export interface ResolvedMcpTools {
	mcpTools: Tool[];
	/** pi tool name (and its lowercase form) → prefixed MCP name. */
	customToolNameToSdk: Map<string, string>;
	/** Prefixed MCP name (and its lowercase form) → pi tool name. */
	customToolNameToPi: Map<string, string>;
}

export function resolveMcpTools(context: TranscriptContext, excludeToolName?: string): ResolvedMcpTools {
	const mcpTools: Tool[] = [];
	const customToolNameToSdk = new Map<string, string>();
	const customToolNameToPi = new Map<string, string>();

	for (const tool of getCurrentTools(context.messages)) {
		if (tool.name === excludeToolName) continue;
		const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
		mcpTools.push(tool);
		customToolNameToSdk.set(tool.name, sdkName);
		customToolNameToSdk.set(tool.name.toLowerCase(), sdkName);
		customToolNameToPi.set(sdkName, tool.name);
		customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
	}

	return { mcpTools, customToolNameToSdk, customToolNameToPi };
}

type McpServers = NonNullable<ReturnType<typeof buildMcpServers>>;

/**
 * Build the in-process MCP server exposing pi's tools.
 *
 * Each handler claims the next tool call id from `turnToolCallIds` (populated as the SDK
 * emits tool_use blocks) and then blocks until pi delivers that result. Results are
 * matched by id, never by position, and a result that arrives before its handler runs is
 * picked up from `pendingResults`.
 *
 * Handlers close over `queryCtx`, so concurrent queries can't resolve each other's calls.
 */
export function buildMcpServers(
	tools: readonly Tool[],
	queryCtx: QueryContext,
): Record<string, ReturnType<typeof createSdkMcpServer>> | undefined {
	if (!tools.length) return undefined;

	const mcpTools = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: jsonSchemaToZodShape(tool.parameters),
		handler: async (): Promise<McpResult> => {
			const toolCallId = queryCtx.turnToolCallIds[queryCtx.nextHandlerIdx++];
			if (!toolCallId) {
				debug(`WARNING: mcp handler ${tool.name} has no toolCallId (idx=${queryCtx.nextHandlerIdx - 1}, available=${queryCtx.turnToolCallIds.length})`);
				return { content: [{ type: "text", text: "Internal error: no tool call id for this handler" }], isError: true };
			}
			const queued = queryCtx.pendingResults.get(toolCallId);
			if (queued) {
				queryCtx.pendingResults.delete(toolCallId);
				debug(`mcp handler: ${tool.name} [${toolCallId}] → resolved from queue (${queryCtx.pendingResults.size} remaining)`);
				return queued;
			}
			debug(`mcp handler: ${tool.name} [${toolCallId}] → waiting`);
			return new Promise<McpResult>((resolve) => {
				queryCtx.pendingToolCalls.set(toolCallId, { toolName: tool.name, resolve });
			});
		},
	}));

	// Cast: the SDK types handlers as returning MCP's CallToolResult. McpResult is the
	// structural subset we produce and pi consumes; the extra index signature is what
	// prevents a direct assignment.
	const server = createSdkMcpServer({
		name: MCP_SERVER_NAME,
		version: "1.0.0",
		tools: mcpTools as unknown as Parameters<typeof createSdkMcpServer>[0]["tools"],
	});
	return { [MCP_SERVER_NAME]: server };
}

export type { McpServers };
