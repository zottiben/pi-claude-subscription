import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

it("loads the Claude provider and compaction hooks without registering delegation tools", async () => {
	const directory = mkdtempSync(join(tmpdir(), "claude-subscription-loader-"));
	try {
		const loader = new DefaultResourceLoader({
			cwd: directory,
			agentDir: directory,
			settingsManager: SettingsManager.inMemory(),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalExtensionPaths: [fileURLToPath(new URL("../../src/index.ts", import.meta.url))],
		});
		await loader.reload();
		const loaded = loader.getExtensions();
		assert.deepEqual(loaded.errors, []);
		assert.deepEqual(loaded.warnings ?? [], []);
		assert.equal(loaded.extensions.length, 1);
		assert.deepEqual([...loaded.extensions[0].tools.keys()], []);
		assert.ok(loaded.extensions[0].handlers.has("session_before_compact"));
		assert.ok(loaded.extensions[0].handlers.has("session_shutdown"));
		assert.ok(loaded.runtime.pendingProviderRegistrations.some(({ name }) => name === "claude-subscription"));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
