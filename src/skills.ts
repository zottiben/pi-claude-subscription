// Skills block extraction + MCP naming constants.
// Kept separate from index.ts so tests can import without activating the extension.

export const MCP_SERVER_NAME = "custom-tools";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

const SKILLS_START_MARKER = "The following skills provide specialized instructions for specific tasks.";
const SKILLS_END_MARKER = "</available_skills>";

/** Extract pi's skills block from its system prompt so it can be forwarded to Claude Code. */
export function extractSkillsBlock(systemPrompt?: string): string | undefined {
	if (!systemPrompt) return undefined;
	const start = systemPrompt.indexOf(SKILLS_START_MARKER);
	if (start === -1) return undefined;
	const end = systemPrompt.indexOf(SKILLS_END_MARKER, start);
	if (end === -1) return undefined;
	return rewriteSkillsBlock(systemPrompt.slice(start, end + SKILLS_END_MARKER.length).trim());
}

/** Point the block's "use the read tool" instruction at the bridged MCP tool name,
 *  since inside Claude Code pi's `read` is only reachable through the MCP server. */
export function rewriteSkillsBlock(skillsBlock: string): string {
	return skillsBlock.replace(
		"Use the read tool to load a skill's file",
		`Use the read tool (${MCP_TOOL_PREFIX}read) to load a skill's file`,
	);
}
