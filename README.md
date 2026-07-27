# pi-claude-subscription

Use your **Claude subscription** as a model provider inside [pi](https://pi.dev), via the
[Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript).

Two features:

1. **Provider** — pick `claude-subscription/claude-opus-4-8` (and friends) with `/model`.
   Turns run through Claude Code, but every tool call flows back through pi's TUI, so it
   behaves like any other pi provider.
2. **AskClaude tool** — when some *other* provider is active, delegate a question or task
   to Claude Code and wait for the answer.

TypeScript throughout, `strict` mode, no build step — pi loads the `.ts` sources directly.

> Derived from [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) by Eli
> Dickinson, itself based on
> [claude-agent-sdk-pi](https://github.com/prateekmedia/claude-agent-sdk-pi) by Prateek
> Sunal. Both MIT; see [LICENSE](LICENSE).

## Install

From GitHub (no npm account needed):

```
pi install git:github.com/zottiben/pi-claude-subscription@v0.1.0
```

Or from a local checkout, which is also the best way to develop — the path is referenced
in place, so edits take effect on `/reload`:

```
pi install /path/to/pi-claude-subscription
```

Or load it for a single run without installing anything:

```
pi -e /path/to/pi-claude-subscription/src/index.ts
```

Add `-l` to any `pi install` to write to project settings (`.pi/settings.json`) instead of
your user settings.

### Migrating from pi-claude-bridge

The two can run side by side — the provider ids (`claude-subscription` vs `claude-bridge`),
config filenames and env vars are all distinct. The one thing that would collide is the
delegation tool, so this extension names its tool `AskClaudeCode` rather than `AskClaude`.
That matters because pi *hard-fails* extension loading on a tool-name conflict, which would
otherwise take down your whole session the moment you installed this alongside the bridge.

Once the bridge is gone you can have the shorter name back:

```json
{ "askClaude": { "name": "AskClaude" } }
```

Remember to update `defaultProvider` in `~/.pi/agent/settings.json` if it still points at
`claude-bridge`, and to `pi remove npm:pi-claude-bridge` when you're done.

A git install clones the repo and runs `npm install --omit=dev` inside it. Note that
`pi update` on a ref-pinned git source only moves the checkout — if a new version adds a
runtime dependency, reinstall rather than update.

## Provider

Use `/model` and pick one of:

| Model | Context |
|---|---|
| `claude-subscription/claude-fable-5` | 1M |
| `claude-subscription/claude-opus-4-8` | 1M |
| `claude-subscription/claude-opus-4-7` | 1M |
| `claude-subscription/claude-opus-4-6` | 200K, or 1M on Max / with extra usage |
| `claude-subscription/claude-sonnet-5` | 1M |
| `claude-subscription/claude-sonnet-4-6` | 200K, or 1M with extra usage |
| `claude-subscription/claude-haiku-4-5` | 200K |

Behind the scenes pi's tools are bridged into Claude Code over an in-process MCP server,
but everything renders and executes in pi as normal. Bash commands get a 120-second default
timeout to match Claude Code, since pi's bash has none.

Your `AGENTS.md` and pi's skills block are forwarded into Claude Code's system prompt, with
pi-specific paths rewritten to their Claude Code equivalents.

**1M context.** Opus 4.7 and 4.8, Fable 5 and Sonnet 5 get 1M by default. Opus 4.6 needs a
Max plan or Extra Usage; Sonnet 4.6 needs Extra Usage on any plan. Set `provider.plan` and
`provider.longContextExtraUsage` accordingly — see [Configuration](#configuration). The
window registered with pi always matches what the extension actually requests, so pi's
status bar and auto-compaction threshold stay accurate.

## AskClaudeCode tool

Available whenever the active provider is *not* `claude-subscription`. Examples:

- "Ask Claude to plan a fix"
- "If you get stuck, ask Claude for help"
- "Ask Claude to review the plan in @foo.md, implement it, then ask an isolated Claude to review the implementation"
- "Ask Claude to poke holes in this theory"

### Parameters

| Parameter | Meaning |
|---|---|
| `prompt` | The question or task. Claude sees the full conversation by default — let it explore rather than researching up front. |
| `mode` | `read` (default), `none`, or `full` (read + write + bash). Disable `full` with `allowFullMode: false`. |
| `model` | `opus` (default), `sonnet`, `haiku`, or a full model id. |
| `thinking` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. |
| `isolated` | `true` gives Claude a clean session with no conversation history. Default `false`. |

## Configuration

`~/.pi/agent/claude-subscription.json` (global), or `.pi/claude-subscription.json` in a
project (merged over global, key by key).

```json
{
  "askClaude": {
    "enabled": true,
    "allowFullMode": true,
    "defaultIsolated": false
  },
  "provider": {
    "plan": "max",
    "longContextExtraUsage": false,
    "strictMcpConfig": true
  }
}
```

### `askClaude`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Register the tool at all. |
| `name` | `"AskClaudeCode"` | Tool name as the model sees it. See [Migrating from pi-claude-bridge](#migrating-from-pi-claude-bridge). |
| `label` | `"Ask Claude Code"` | Label in the TUI. |
| `description` | — | Override the description shown to the calling model. |
| `defaultMode` | `"read"` | Mode when the caller omits one. |
| `defaultIsolated` | `false` | Start each call in a fresh session. |
| `allowFullMode` | `true` | Set `false` to lock out write/bash access entirely. |
| `appendSkills` | `true` | Forward pi's skills block into the delegated system prompt. |

### `provider`

| Key | Default | Meaning |
|---|---|---|
| `plan` | `"pro"` | Set `"max"` for Max / Team Premium / Enterprise, which enables Opus 4.6 at 1M. |
| `longContextExtraUsage` | `false` | Opt into metered 1M context. Enables Sonnet 4.6 1M everywhere and Opus 4.6 1M on Pro. |
| `appendSystemPrompt` | `true` | Append your AGENTS.md and skills block. |
| `settingSources` | — | Claude Code filesystem settings to load. Only applied when `appendSystemPrompt` is `false`. |
| `strictMcpConfig` | `true` | Block MCP servers from `~/.claude.json` and `.mcp.json`. claude.ai cloud MCP is always blocked. |
| `pathToClaudeCodeExecutable` | — | Path to the `claude` binary, for when the SDK's bundled binaries can't run (e.g. Nix). |

Pi's `modelOverrides` in `~/.pi/agent/models.json` do not apply to extension-registered
providers, so changing `contextWindow` means editing `src/models.ts`.

## Development

Node >= 22.19.0, the floor set by pi's own packages.

```
npm install
npm run typecheck     # tsc --noEmit, strict
npm test              # unit tests, offline
npm run check         # both of the above — what CI runs
npm run test:integration   # drives the real `pi` binary, uses subscription quota
```

The integration suite needs `pi` on your PATH and a logged-in Claude Code. It is
deliberately excluded from `npm test` and from CI.

### Layout

| File | Responsibility |
|---|---|
| `index.ts` | Extension entry point: registration and event wiring |
| `provider.ts` | The provider — one Claude Code query spanning many pi calls |
| `stream.ts` | SDK message stream → pi assistant event stream |
| `session-sync.ts` | REUSE/REBUILD decisions keeping Claude Code's session JSONL in step with pi |
| `tool-bridge.ts` | Exposing pi's tools over MCP and translating names/arguments |
| `ask-claude.ts` | The AskClaude tool and its mode gate |
| `convert.ts` | pi → Anthropic message conversion |
| `models.ts` | Model catalogue and the long-context policy |

## Debugging

Set `CLAUDE_SUBSCRIPTION_DEBUG=1`:

- **Extension log** at `~/.pi/agent/claude-subscription.log` — every provider call, session
  sync decision, tool result delivery, and Claude Code's stderr. Override the location with
  `CLAUDE_SUBSCRIPTION_DEBUG_PATH`.
- **Per-query Claude Code CLI logs** at `~/.pi/agent/cc-cli-logs/<timestamp>-<tag>-<seq>.log`
  — the subprocess's own debug stream, one file per query. Tags are `provider` (main turn),
  `continuation` (steer replay), `askclaude`, or `compact-summary`.

For a session-resume failure ("No conversation found"), the useful attachments are the
`syncResult:` lines from the extension log plus the matching `cc-cli-logs/` file.

Unconditional diagnostics for should-never-happen paths land in
`~/.pi/agent/claude-subscription-diag.log` even without the debug flag.

## Maintenance

After a Claude Code release, review `MODE_DISALLOWED_TOOLS` in `src/ask-claude.ts`. It gates
which Claude Code tools an AskClaude delegation may invoke per mode; new agentic tools that
shouldn't be reachable from a subagent belong in the appropriate list.

## Releasing

Tag-driven:

```
npm version minor          # bumps package.json, creates the v* tag
git push --follow-tags
```

CI verifies the tag matches `package.json`, runs typecheck and tests, checks the packaged
tarball actually contains the extension entry point, and cuts a GitHub Release.

npm publishing is wired up but off. To enable it: add an npm automation token as the
`NPM_TOKEN` repository secret, then add a repository variable `PUBLISH_TO_NPM` set to
`true`. The job publishes with `--provenance`.

## License

MIT — see [LICENSE](LICENSE).
