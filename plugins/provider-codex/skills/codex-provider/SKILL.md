---
name: codex-provider
description: "Diagnose Cloudroom-specific Codex session controls, model acceptance, and durable goals."
---

# Codex provider

Codex supports structured plan requests, editing and rerunning eligible messages,
and compaction through the corresponding core `cloudroom thread` commands.
`cloudroom thread clear-goal <id>` clears its durable active Goal and waits for provider
confirmation. Inspect the thread before recovery actions.

Unlisted model IDs are accepted by this provider; acceptance does not establish
account access. Inspect models on the actual execution host with
`cloudroom provider models codex` using the machine or environment selector.

Use the core CLI skill for command syntax and official Codex guidance for
upstream product behavior.
