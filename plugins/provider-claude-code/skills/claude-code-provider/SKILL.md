---
name: claude-code-provider
description: "Configure or troubleshoot Cloudroom-specific Claude Code provider settings and session behavior."
---

# Claude Code provider

Read settings with `cloudroom plugin config provider-claude-code`; change a declared key
with `cloudroom plugin config provider-claude-code set <key> <value>`.

- `chromeEnabled` defaults to `false`. It starts Claude Code with `--chrome` for
  Claude in Chrome tools. The host needs the extension and a claude.ai login.
  A change restarts the thread's Claude process before its next turn, preserving
  context.
- Structured plan, message editing, and compaction are supported through the
  corresponding `cloudroom thread` commands. Unlisted model IDs are accepted by the
  provider; verify actual availability on the target host.

Inspect the thread and provider state after a change; do not restart unrelated
threads or change settings merely to answer a question.
