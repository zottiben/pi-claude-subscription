// Unit tests for extracting pi's skills block and retargeting it at the MCP read tool.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractSkillsBlock, MCP_TOOL_PREFIX, rewriteSkillsBlock } from "../../src/skills.js";

const SYSTEM_PROMPT = `You are a coding assistant.

The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory.

<available_skills>
  <skill>
    <name>br</name>
    <description>Browser automation CLI.</description>
    <location>/skills/br/SKILL.md</location>
  </skill>
</available_skills>

Some other system prompt content after skills.`;

describe("extractSkillsBlock", () => {
	it("extracts from the start marker through the closing tag", () => {
		const block = extractSkillsBlock(SYSTEM_PROMPT);
		assert.ok(block);
		assert.match(block, /^The following skills provide/);
		assert.match(block, /<\/available_skills>$/);
	});

	it("excludes surrounding prompt text", () => {
		const block = extractSkillsBlock(SYSTEM_PROMPT);
		assert.ok(block);
		assert.doesNotMatch(block, /You are a coding assistant/);
		assert.doesNotMatch(block, /Some other system prompt content/);
	});

	it("returns undefined when the prompt has no skills block", () => {
		assert.equal(extractSkillsBlock("You are a coding assistant."), undefined);
	});

	it("returns undefined for an undefined prompt", () => {
		assert.equal(extractSkillsBlock(undefined), undefined);
	});

	it("returns undefined when the block is unterminated", () => {
		const truncated = SYSTEM_PROMPT.slice(0, SYSTEM_PROMPT.indexOf("</available_skills>"));
		assert.equal(extractSkillsBlock(truncated), undefined);
	});
});

describe("rewriteSkillsBlock", () => {
	it("points the read instruction at the bridged MCP tool", () => {
		const rewritten = rewriteSkillsBlock("Use the read tool to load a skill's file when needed.");
		assert.equal(rewritten, `Use the read tool (${MCP_TOOL_PREFIX}read) to load a skill's file when needed.`);
	});

	it("leaves text without the instruction untouched", () => {
		assert.equal(rewriteSkillsBlock("no instruction here"), "no instruction here");
	});

	it("is applied by extractSkillsBlock", () => {
		const block = extractSkillsBlock(SYSTEM_PROMPT);
		assert.ok(block);
		assert.match(block, new RegExp(`${MCP_TOOL_PREFIX}read`));
	});
});
