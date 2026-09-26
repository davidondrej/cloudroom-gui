---
name: automations
description: "Schedule or manage recurring and one-shot Cloudroom agent or script automations."
---

# Automations

An automation is a scheduled task. When due it runs in one of two modes:

agent Spawn a thread or re-prompt a target thread with a configured prompt.
script Run a stored server-side script and capture stdout/stderr/exit.

Use the top-level `cloudroom automation` command. The CLI routes it to this plugin.

Pass `--project` explicitly for every automation command. Inside a thread, automations are stamped origin `agent` and record the creating thread automatically. Automation-spawned threads cannot create automations.

Personal supports automations with `--project proj_personal`. Use `cloudroom project list --include-personal --json` to include it in discovery; an empty default project list does not mean Personal is unavailable.

Choosing a mode:

Use `script` when the output is fully determined by code: watchdogs, threshold alerts, health checks, heartbeats, and API pollers with a fixed output shape. Scripts run on the Cloudroom server, with cwd inside the plugin data directory's `scripts/` area. Script automations do not have an environment field and do not accept environment flags.

Design the script to print nothing when there is nothing to report: an exit-0 run with empty stdout/stderr, or a last non-empty line of `{"wakeAgent": false}`, is recorded as a skipped silent tick. Any other output is captured; non-zero exit or timeout is recorded as a failed run.

Use `agent` when the run needs reasoning: summarize a feed, pick interesting items, draft a human-friendly message, or branch on content.

Creating:

```bash
cloudroom automation create --project <id> --name "..." [schedule flags] [mode flags]
```

For creation flags and mode-specific defaults, read
[references/creation.md](references/creation.md).

Read `references/script-runtime.md` before you use a script file, depend on
injected variables, or diagnose retries, timeouts, restarts, and silent runs.

Managing:

```bash
cloudroom automation list --project <id>
cloudroom automation show <automationId> --project <id>
cloudroom automation update <automationId> --project <id> [--name <name>] [schedule flags] [complete execution flags | partial agent update flags]
cloudroom automation pause <automationId> --project <id>
cloudroom automation resume <automationId> --project <id>
cloudroom automation run <automationId> --project <id> [--idempotency-key <key>]
cloudroom automation runs <automationId> --project <id> [--limit <count>] [--output <runId>]
cloudroom automation delete <automationId> --project <id> --yes
```

For partial updates, mode replacement, execution targets, or damaged records,
read [references/updates.md](references/updates.md). Every command supports `--json`.
