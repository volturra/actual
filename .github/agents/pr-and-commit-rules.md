# PR and Commit Rules for AI Agents

This file lists the PR and commit rules you have to apply yourself.

> **Fork note (volturra/actual):** these rules are loosened from upstream
> actualbudget/actual for work on this fork. Agents write the PR description,
> and GitHub comments don't need a 🤖 prefix. The `[AI]` prefix stays so changes
> can still be offered upstream later. When opening a PR against
> actualbudget/actual itself, follow upstream's rules instead (blank PR
> template, 🤖 prefix on comments).

## Pull Request Rules

### `[AI]` prefix on PR titles

**ALL pull request titles MUST be prefixed with `[AI]`** — you have to apply it
yourself.

**Examples:**

- `[AI] Fix type error in account validation`
- `Fix type error in account validation` (MISSING PREFIX — NOT ALLOWED)

### PR description

Use the PR template (`.github/PULL_REQUEST_TEMPLATE.md`) as the layout and fill
it in, in English: what changed and why, related issues, and what you tested.
Only check a checklist box when it is actually true.

## Do not create GitHub issues

**Agents must never create GitHub issues.** Filing an issue is a human
decision — neither the GitHub MCP tools (`issue_write` with method `create`)
nor the `gh` CLI (`gh issue create`) may be used to open one; agent hooks
block both. If you believe an issue should exist, share the proposed title
and body with the user and let them file it. Updating existing issues (and
commenting on them) remains allowed.
