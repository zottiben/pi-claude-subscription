# Context windows served by the Claude Agent SDK

The runtime table in `src/models.ts` is measured, not inferred. It cannot be derived from a
model's advertised context window: bare Opus 4.7 has served 1M while bare Opus 4.8 served
200K, and `[1m]` entitlement varies by model, plan, and whether Extra Usage is enabled.

## Method

`diag/context-size.ts` calls the SDK once per model id × {bare, `[1m]`} with one trivial
turn, and records `result.modelUsage[*].contextWindow`. Auth is subscription OAuth
(claude.ai) with `ANTHROPIC_API_KEY` unset.

```
npx tsx diag/context-size.ts                 # every catalogue model
npx tsx diag/context-size.ts claude-opus-5   # one id, bare and [1m]
```

Options used: `settingSources: []`, `tools: []`, `skills: []`, `maxTurns: 1`,
`persistSession: false`, model passed via `extraArgs.model` — which is the path the
provider itself uses.

## Measurements

**2026-07-27**, Claude Agent SDK 0.3.220, Pro plan, Extra Usage off.

| requested id | served context | served model |
|---|---|---|
| `claude-opus-5` | 1M | `claude-opus-5` |
| `claude-opus-5[1m]` | 1M | `claude-opus-5[1m]` |
| `claude-opus-4-8` | 1M | `claude-opus-4-8` |
| `claude-opus-4-8[1m]` | 1M | `claude-opus-4-8[1m]` |
| `claude-opus-4-7` | 1M | `claude-opus-4-7` |
| `claude-opus-4-7[1m]` | 1M | `claude-opus-4-7` |

Cross-checked by passing the model through `options.model` instead of `extraArgs.model`;
both paths agreed on every row.

### Entitlement has changed since the upstream measurements

pi-claude-bridge measured this table on 2026-06-26 against SDK 0.2.141 and recorded bare
`claude-opus-4-8` serving **200K** on every plan. As of 2026-07-27 bare `claude-opus-4-8`
serves **1M** on Pro with Extra Usage off.

So the bare-vs-`[1m]` distinction that motivated the original table has, at least for
current-generation Opus, stopped mattering. Two consequences:

- Re-measure rather than trusting this file after any Claude Code release.
- The table keeps sending `[1m]` for models where 1M is wanted. Requesting it explicitly is
  the safer side of the trade: a default that grants 1M today can be narrowed again, whereas
  an explicit request either succeeds or fails loudly.

The one case where an unnecessary `[1m]` is actively harmful is a model whose 1M is a paid
add-on: upstream recorded `claude-opus-4-6[1m]` and `claude-sonnet-4-6[1m]` returning 429 on
Pro with credits off. That is why those two stay gated behind `plan` and
`longContextExtraUsage` instead of always carrying the suffix.

## Note on max output tokens

The probe also reports `maxOutputTokens`, which came back as 64K for every model above,
while pi-ai's catalogue advertises 128K. This is recorded rather than acted on: the
extension does not send a max-tokens value, so the served figure is Claude Code's own
default for a one-turn probe and not necessarily what a real session gets.
