// Probe: which context window does the Claude Agent SDK actually serve, per model id?
//
// The runtime table in src/models.ts cannot be derived from a model's advertised context
// window. Bare Opus 4.7 serves 1M; bare Opus 4.8 serves 200K and needs an explicit [1m]
// suffix. Entitlement also varies by plan and by whether Extra Usage is enabled. So the
// table is measured, and this is what measures it.
//
// Usage:
//   npx tsx diag/context-size.ts                      # probe every catalogue model
//   npx tsx diag/context-size.ts claude-opus-5        # probe one id, bare and [1m]
//
// Auth is whatever the Claude Code CLI already uses (subscription OAuth). Each probe is
// one trivial turn with no tools and no persisted session.

import { query, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig } from "../src/config.js";
import { MODEL_IDS_IN_ORDER } from "../src/models.js";

const claudeExecutable = loadConfig(process.cwd()).provider?.pathToClaudeCodeExecutable;

interface Probe {
	requested: string;
	contextWindow: number | null;
	maxOutputTokens: number | null;
	servedModel: string | null;
	error: string | null;
}

async function probe(modelId: string): Promise<Probe> {
	const result: Probe = { requested: modelId, contextWindow: null, maxOutputTokens: null, servedModel: null, error: null };

	try {
		const sdkQuery = query({
			prompt: "Reply with the single word: ok",
			options: {
				env: { ...process.env, DISABLE_AUTO_COMPACT: "1" },
				tools: [],
				strictMcpConfig: true,
				settingSources: [] as SettingSource[],
				skills: [],
				persistSession: false,
				maxTurns: 1,
				...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
				extraArgs: { model: modelId, "strict-mcp-config": null },
			},
		});

		try {
			for await (const message of sdkQuery) {
				if (message.type !== "result") continue;
				for (const [served, usage] of Object.entries(message.modelUsage ?? {})) {
					result.servedModel = served;
					result.contextWindow = usage.contextWindow ?? null;
					result.maxOutputTokens = usage.maxOutputTokens ?? null;
				}
				if (message.subtype !== "success") {
					result.error = message.errors?.join("; ") ?? message.subtype;
				}
			}
		} finally {
			sdkQuery.close();
		}
	} catch (err) {
		result.error = err instanceof Error ? err.message : String(err);
	}

	return result;
}

function format(n: number | null): string {
	if (n === null) return "—";
	if (n >= 1_000_000) return `${n / 1_000_000}M`;
	if (n >= 1_000) return `${n / 1_000}K`;
	return String(n);
}

const targets = process.argv.slice(2);
const ids = targets.length > 0 ? targets : [...MODEL_IDS_IN_ORDER];

console.log(`Probing ${ids.length} model id(s), bare and [1m]. One turn each.\n`);
console.log("| requested id | served ctx | max out | served model | error |");
console.log("|---|---|---|---|---|");

for (const id of ids) {
	for (const requested of [id, `${id}[1m]`]) {
		const r = await probe(requested);
		console.log(`| \`${r.requested}\` | ${format(r.contextWindow)} | ${format(r.maxOutputTokens)} | ${r.servedModel ?? "—"} | ${r.error ?? ""} |`);
	}
}
