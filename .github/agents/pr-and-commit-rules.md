# PR and Commit Rules for AI Agents

This file lists the PR and commit rules you have to apply yourself.

> **Fork note (volturra/actual):** these rules are loosened from upstream
> actualbudget/actual for work on this fork. Agents write the whole PR
> description (no human-only summary or proof section is enforced), and GitHub
> comments don't need a 🤖 prefix. PR titles and commit messages take no prefix.
> When opening a PR against actualbudget/actual itself, follow upstream's rules
> instead: leave the Human Summary for the human author, keep Description and
> Testing to 150 words in total, add a Proof section, and prefix comments with 🤖.

## Pull Request Rules

### Draft PRs

Open a PR as a draft while the work is still in progress, and mark it ready for
review once it is done.

### PR description

Use the PR template (`.github/PULL_REQUEST_TEMPLATE.md`) as the layout and fill
it in, in English: what changed and why, related issues, and what you tested.
On this fork you may write the Human Summary too, and the Proof section is
optional, whatever the template's comments say. Only check a checklist box when
it is actually true.

## Do not create GitHub issues

**Agents must never create GitHub issues.** Filing an issue is a human
decision — neither the GitHub MCP tools (`issue_write` with method `create`)
nor the `gh` CLI (`gh issue create`) may be used to open one; agent hooks
block both. If you believe an issue should exist, share the proposed title
and body with the user and let them file it. Updating existing issues (and
commenting on them) remains allowed.
