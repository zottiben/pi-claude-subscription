# Project guidance

## Pi transcript compatibility

`@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` are the extension's real
runtime API surface. A peer-dependency update can change runtime shapes without producing
a useful type error, so audit every `context.messages` and compaction call site after an
upgrade. Run `npm run check`; a green typecheck alone is not sufficient.

Since Pi 0.86, `normalizeContext()` folds the system prompt and tool declarations into a
leading system message. A summarization context that previously looked like `[user]` now
looks like `[system, user]`. Do not assume `messages[0]` is conversational or validate a
transcript by its raw length. Use Pi's transcript helpers:

- `withoutInitialSystemMessage()` for APIs that carry the system prompt separately.
- `getCurrentSystemPrompt()` and `getCurrentTools()` to replay system-message state.

Later system messages are also legal, so hand-written first-message checks are unsafe.

This caused the v0.2.2 compaction regression in `extractIsolatedSummaryPrompt`: its
single-user-message guard rejected Pi's normalized `[system, user]` context before Claude
Code was spawned. Keep `tests/unit/compact-takeover.test.ts` based on the real
`normalizeContext()` shape so future upstream changes fail locally.

## Compaction takeover is load-bearing

`session_before_compact` deliberately returns `{ cancel: true }` if the extension's
takeover throws, because Pi's native compaction cannot drive a Claude Code model and is
known to hang. A takeover regression therefore leaves the context oversized: the next
turn can report `Prompt is too long`, retry compaction, and fail the same way. Preserve a
regression test for every bug in this path.

## Releases

Releases are tag-driven. The tag must match `package.json`. Update `package.json`,
`package-lock.json`, the README install example, and the version references in the header
of `.github/workflows/release.yml`; then push the commit and matching `vX.Y.Z` tag.
GitHub generates the release notes; there is no `CHANGELOG.md`.
