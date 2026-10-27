# pi-claude-subscription

Use your **Claude subscription** as a model provider inside [pi](https://pi.dev), via the
[Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript).

Pick `claude-subscription/claude-opus-5-5` (and friends) with `/model`.
Turns run through Claude Code, but every tool call flows back through pi's TUI, so it
behaves like any other pi provider. This extension provides model access, not review
or delegation tools.

TypeScript throughout, `strict` mode, no build step — pi loads the `.ts` sources directly.

> Derived from [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) by Eli
> Dickinson, itself based on
> [claude-agent-sdk-pi](https://github.com/prateekmedia/claude-agent-sdk-pi) by Prateek
> Sunal. Both MIT; see [LICENSE](LICENSE).

## Install

From GitHub (no npm account needed):

```
pi install git:github.com/zottiben/pi-claude-subscription@v0.5.0
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

The provider ids (`claude-subscription` vs `claude-bridge`), config filenames and
environment variables are distinct. Update `defaultProvider` in
`~/.pi/agent/settings.json` if it still points at `claude-bridge`, then run
`pi remove npm:pi-claude-bridge` when migration is complete.

### Upgrading from v0.4.x

Version 0.5.0 removes `AskClaudeCode` and its delegation implementation. Existing
`askClaude` configuration is ignored and can be deleted. Provider configuration,
model access, tool bridging and compaction are unchanged. Restart every running Pi
process after updating to unload the old tool. Cross-vendor review belongs in a
separate, explicitly invoked skill, not in the provider.

A git install clones the repo and runs `npm install --omit=dev` inside it. Note that
`pi update` on a ref-pinned git source only moves the checkout — if a new version adds a
runtime dependency, reinstall rather than update.

## Provider

Use `/model` and pick one of:

| Model | Context |
|---|---|
| `claude-subscription/claude-opus-5-5` | 1M |
| `claude-subscription/claude-opus-5` | 1M |
| `claude-subscription/claude-fable-5-1` | 1M |
| `claude-subscription/claude-fable-5` | 1M |
| `claude-subscription/claude-opus-4-8` | 1M |
| `claude-subscription/claude-opus-4-7` | 1M |
| `claude-subscription/claude-opus-4-6` | 200K, or 1M on Max / with extra usage |
| `claude-subscription/claude-sonnet-5-5` | 1M |
| `claude-subscription/claude-sonnet-5` | 1M |
| `claude-subscription/claude-sonnet-4-6` | 200K, or 1M with extra usage |
| `claude-subscription/claude-haiku-5-5` | 1M |
| `claude-subscription/claude-haiku-4-5` | 200K |

Behind the scenes pi's tools are bridged into Claude Code over an in-process MCP server,
but everything renders and executes in pi as normal. Bash commands get a 120-second default
timeout to match Claude Code, since pi's bash has none.

Your `AGENTS.md` and pi's skills block are forwarded into Claude Code's system prompt, with
pi-specific paths rewritten to their Claude Code equivalents.

**1M context.** Opus 5.5, Opus 5, Opus 4.7 and 4.8, Fable 5.1, Fable 5, Sonnet 5.5,
Sonnet 5 and Haiku 5.5 get 1M by default. Opus 4.6 needs a Max plan or Extra Usage;
Sonnet 4.6 needs Extra Usage on any plan. Set `provider.plan` and
`provider.longContextExtraUsage` accordingly, see [Configuration](#configuration). The
window registered with pi always matches what the extension actually requests. The provider
signals auto-compaction before Claude Code's served output headroom is exhausted (128K for
Opus, Sonnet and Haiku 5.5), rather than waiting for the last 16K of the advertised window.

## Configuration

`~/.pi/agent/claude-subscription.json` (global), or `.pi/claude-subscription.json` in a
project (merged over global, key by key).

```json
{
  "provider": {
    "plan": "max",
    "longContextExtraUsage": false,
    "strictMcpConfig": true
  }
}
```

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
npm run diag:context       # re-measure served context windows per model id
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
| `convert.ts` | pi → Anthropic message conversion |
| `models.ts` | Model catalogue and the long-context policy |

## Debugging

Set `CLAUDE_SUBSCRIPTION_DEBUG=1`:

- **Extension log** at `~/.pi/agent/claude-subscription.log` — every provider call, session
  sync decision, tool result delivery, and Claude Code's stderr. Override the location with
  `CLAUDE_SUBSCRIPTION_DEBUG_PATH`.
- **Per-query Claude Code CLI logs** at `~/.pi/agent/cc-cli-logs/<timestamp>-<tag>-<seq>.log`
  — the subprocess's own debug stream, one file per query. Tags are `provider` (main turn),
  `continuation` (steer replay), or `compact-summary`.

For a session-resume failure ("No conversation found"), the useful attachments are the
`syncResult:` lines from the extension log plus the matching `cc-cli-logs/` file.

Unconditional diagnostics for should-never-happen paths land in
`~/.pi/agent/claude-subscription-diag.log` even without the debug flag.

## Maintenance

After a Claude Code release:

- Re-run `npm run diag:context` and reconcile `src/models.ts` against it. The served context
  window is entitlement, not a property of the model, and it has changed before — see
  [diag/CONTEXT-SIZE.md](diag/CONTEXT-SIZE.md).

Adding a model means one entry in `MODEL_IDS_IN_ORDER` and one case in
`resolveClaudeCodeRuntimeModel`, both in `src/models.ts`.

Ids that neither pi-ai nor `PI_AI_FALLBACK_MODELS` knows are dropped silently. pi-ai
typically ships a new model id some releases after Claude Code serves it, so a model
released in between needs a `PI_AI_FALLBACK_MODELS` entry to appear at all. pi-ai's own
entry wins as soon as it exists. Keep the fallback until the package's minimum supported
pi-ai version includes the model; then delete it rather than leave two sources of truth.

A model can also need a newer Claude Code than the pinned
`@anthropic-ai/claude-agent-sdk` bundles (Haiku 5.5 needs v2.1.293+, Sonnet 5.5 needs
v2.1.284+, Opus 5.5 needs v2.1.280+, and Fable 5.1 needs v2.1.255+). SDK `0.3.x` bundles
Claude Code `2.1.x`; this release uses SDK 0.3.300. Bump the SDK in the same change,
or the id is rejected at runtime. This does not apply when
`provider.pathToClaudeCodeExecutable` points at your own
CLI, where that binary's version is what counts.

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
