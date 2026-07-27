// User-facing extension config, loaded once at extension registration from
// ~/.pi/agent/claude-subscription.json and the project pi config directory
// (project overriding global). Missing or unparseable files are ignored — an
// error goes to console.error and an empty object is returned — so a typo in
// the config can never stop the extension from starting.

import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE_NAME, LOG_PREFIX } from "./constants.js";

export type AskClaudeMode = "full" | "read" | "none";

export interface AskClaudeConfig {
	/** Register the AskClaude tool at all. Default true. */
	enabled?: boolean;
	/** Override the tool's pi-side name. Default "AskClaude". */
	name?: string;
	/** Override the TUI label. Default "Ask Claude Code". */
	label?: string;
	/** Override the description shown to the calling model. */
	description?: string;
	/** Mode used when the caller omits `mode`. Default "read". */
	defaultMode?: AskClaudeMode;
	/** Start each call in a fresh session with no conversation history. Default false. */
	defaultIsolated?: boolean;
	/** Allow `mode: "full"`. Set false to lock write/bash access out entirely. Default true. */
	allowFullMode?: boolean;
	/** Forward pi's skills block into the delegated system prompt. Default true. */
	appendSkills?: boolean;
}

/** Low-level Claude Agent SDK plumbing. Most users won't need these. */
export interface ProviderConfig {
	/** Append pi's AGENTS.md and skills block to the Claude Code system prompt. Default true. */
	appendSystemPrompt?: boolean;
	/** Claude Code filesystem settings to load. Only applied when appendSystemPrompt is false. */
	settingSources?: SettingSource[];
	/** Block MCP servers declared in ~/.claude.json and .mcp.json. Default true. */
	strictMcpConfig?: boolean;
	/** Path to the `claude` binary, for when the SDK's bundled binaries can't run (e.g. Nix). */
	pathToClaudeCodeExecutable?: string;
	/** Subscription tier. "max" enables Opus 4.6 at 1M context. Default "pro". */
	plan?: "pro" | "max";
	/** Opt into metered 1M context ("extra usage" billing). Enables Sonnet 4.6 [1m] on
	 *  every plan and Opus 4.6 [1m] on Pro. */
	longContextExtraUsage?: boolean;
}

export interface Config {
	askClaude?: AskClaudeConfig;
	provider?: ProviderConfig;
}

export function tryParseJson(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			console.error(`${LOG_PREFIX}: ignoring ${path}: expected a JSON object`);
			return {};
		}
		return parsed as Partial<Config>;
	} catch (e) {
		console.error(`${LOG_PREFIX}: failed to parse ${path}: ${e}`);
		return {};
	}
}

export function globalConfigPath(): string {
	return join(homedir(), ".pi", "agent", CONFIG_FILE_NAME);
}

export function projectConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

export function loadConfig(cwd: string): Config {
	const global = tryParseJson(globalConfigPath());
	const project = tryParseJson(projectConfigPath(cwd));
	return {
		askClaude: { ...global.askClaude, ...project.askClaude },
		provider: { ...global.provider, ...project.provider },
	};
}
