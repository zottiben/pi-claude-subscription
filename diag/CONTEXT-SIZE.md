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

**2026-09-03**, Claude Agent SDK 0.3.259 (Claude Code 2.1.259), Pro plan, Extra Usage off.
Full catalogue, re-measured after the SDK bump that Fable 5.1 required.

| requested id | served context | served model |
|---|---|---|
| `claude-opus-5` | 1M | `claude-opus-5` |
| `claude-opus-5[1m]` | 1M | `claude-opus-5[1m]` |
| `claude-fable-5-1` | 1M | `claude-fable-5-1` |
| `claude-fable-5-1[1m]` | 1M | `claude-fable-5-1` |
| `claude-fable-5` | 1M | `claude-fable-5` |
| `claude-fable-5[1m]` | 1M | `claude-fable-5` |
| `claude-opus-4-8` | 1M | `claude-opus-4-8` |
| `claude-opus-4-8[1m]` | 1M | `claude-opus-4-8[1m]` |
| `claude-opus-4-7` | 1M | `claude-opus-4-7` |
| `claude-opus-4-7[1m]` | 1M | `claude-opus-4-7[1m]` |
| `claude-opus-4-6` | 200K | `claude-opus-4-6` |
| `claude-opus-4-6[1m]` | 1M | `claude-opus-4-6[1m]` |
| `claude-sonnet-5` | 1M | `claude-sonnet-5` |
| `claude-sonnet-5[1m]` | 1M | `claude-sonnet-5[1m]` |
| `claude-sonnet-4-6` | 200K | `claude-sonnet-4-6` |
| `claude-sonnet-4-6[1m]` | 1M | `claude-sonnet-4-6[1m]` |
| `claude-haiku-4-5` | 200K | `claude-haiku-4-5` |
| `claude-haiku-4-5[1m]` | rejected, 400 "The long context beta is not yet available for this subscription" | none |

Fable 5.1 serves 1M bare and with `[1m]`, neither rejected, so it is entered in the runtime
table with the suffix on the same reasoning as Opus 5: an explicit request rather than a
default that can be narrowed later.

### The 4.6 gate is now looser than the table assumes

`claude-opus-4-6[1m]` and `claude-sonnet-4-6[1m]` both served 1M here on **Pro with Extra
Usage off**, the combination that upstream recorded returning 429 and the reason
`src/models.ts` gates those two behind `plan` and `longContextExtraUsage`.

The gate is deliberately left in place. One account serving 1M does not establish that
every Pro account is entitled to it, and the `claude-haiku-4-5[1m]` rejection in the same
run shows the entitlement check is still live and still returns a hard error. Loosening the
gate would trade a conservative 200K for a failed request on any account that lacks the
entitlement. Revisit it only with measurements from more than one account.

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

The probe also reports `maxOutputTokens`, which came back as 64K for every model above
(32K for Sonnet 4.6 and Haiku 4.5 in the 2026-09-03 run), while pi-ai's catalogue
advertises 128K. This is recorded rather than acted on: the
extension does not send a max-tokens value, so the served figure is Claude Code's own
default for a one-turn probe and not necessarily what a real session gets.
