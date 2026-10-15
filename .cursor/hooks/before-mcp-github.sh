#!/bin/sh
# Cursor `beforeMCPExecution` adapter.
#
# Dispatches github MCP calls to the matching shared guard(s) in
# scripts/agent-hooks/: issue_write must not create issues (no-issue-create.sh).
# This fork doesn't wire upstream's 🤖-prefix (github-comment-style.sh) or
# blank-PR-template (pr-template-blank.sh) guards; see
# .github/agents/pr-and-commit-rules.md.
# Cursor input on stdin: { tool_name, tool_input, ... }. Output on stdout:
# { permission: "allow" | "deny", userMessage, agentMessage }.

# jq is a hard prerequisite — even deny() below needs it to build JSON — so
# fail closed with a static deny instead of emitting nothing at all.
command -v jq >/dev/null 2>&1 || {
  printf '%s\n' '{"permission":"deny","userMessage":"Blocked by repo policy","agentMessage":"The agent hooks require jq, which was not found on PATH. Install jq (https://jqlang.org) and retry."}'
  exit 0
}

input=$(cat)
# `CDPATH= cd` is an intentional empty-env prefix (not an assignment); silence the
# SC1007 false positive shellcheck raises for it.
# shellcheck disable=SC1007
ROOT=$(CDPATH= cd "$(dirname "$0")/../.." && pwd)

allow() {
  printf '%s\n' '{"permission":"allow"}'
  exit 0
}
deny() {
  jq -n --arg m "$1" \
    '{permission:"deny", userMessage:"Blocked by repo policy", agentMessage:$m}'
  exit 0
}

# Pick the guard(s) for this tool; wave known non-GitHub tools by. Fail closed
# on a malformed payload (jq parse failure / missing .tool_name), matching
# guard-shell.sh — a payload we can't read must not bypass the GitHub guards.
tool=$(printf '%s' "$input" | jq -re '.tool_name' 2>/dev/null) ||
  deny "Invalid Cursor hook payload: could not read .tool_name."
case "$tool" in
  mcp__github__issue_write)
    guards=no-issue-create.sh ;;
  *) allow ;;
esac

# Each guard reads the same `.tool_input.*` payload Cursor passes, so forward it
# unchanged; the first guard to object wins. Exit 0 allows, exit 2 + stderr is a
# real policy denial. Fail closed on any other exit (matching guard-shell.sh) so
# a broken/missing guard can't silently disable enforcement; the message marks
# it as an execution problem. (Each guard fails closed on an unreadable payload
# and exit-0s only when there's genuinely nothing to enforce.)
for guard in $guards; do
  status=0
  err=$(printf '%s' "$input" | "$ROOT/scripts/agent-hooks/$guard" 2>&1) || status=$?
  case "$status" in
    0) ;;
    2) deny "$err" ;;
    *) deny "$guard failed (exit $status): $err" ;;
  esac
done
allow
