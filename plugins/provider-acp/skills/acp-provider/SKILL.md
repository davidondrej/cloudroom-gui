---
name: acp-provider
description: "Configure or troubleshoot ACP agent discovery, custom models, skills, and compaction in Room."
---

# ACP providers

Known agents can be discovered automatically when their CLI is installed on the
host: `opencode`, `omp`, `grok`, and `hermes` appear as `acp-opencode`, `acp-omp`,
`acp-grok`, and `acp-hermes-agent`. Inspect the target host's catalog with
`room provider list` and `room provider models <provider-id>` using its environment
or machine selector.

Cursor project skills come from `.cursor/skills`, which can link to
`.agents/skills`. Room lists these linked skills as read-only under `cursor-project`.

ACP agents may reject unlisted model IDs. OpenCode requires models in its own
configuration; Room discovers them there. OpenCode agents are session modes, not
models selectable through Room's model field.

OpenCode ACP supports the core `room thread compact` command; Cursor ACP does not
expose compatible compaction. Check the actual agent's capabilities before
attempting provider-specific recovery.
