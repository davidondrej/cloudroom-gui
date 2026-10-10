---
name: automations
description: "Schedule or manage recurring and one-shot Cloudroom agent or script automations."
---

# Automations

An automation is a scheduled task. When due it runs in one of two modes:

agent Spawn a thread or re-prompt a target thread with a configured prompt.
script Run a stored server-side script and capture stdout/stderr/exit.

Use the top-level `room-cli automation` command. The CLI routes it to this plugin.

Pass `--project` explicitly for every automation command. Inside a thread, automations are stamped origin `agent` and record the creating thread automatically. Automation-spawned threads cannot create automations.

Personal supports automations with `--project proj_personal`. Use `room-cli project list --include-personal --json` to include it in discovery; an empty default project list does not mean Personal is unavailable.

Local or cloud:

Automations above run on this Mac, only while it is awake and Cloudroom is running. A cloud automation runs on Cloudroom's servers instead: it re-prompts one existing Cloud thread (its harness and model) on a schedule, even while the Mac is off. Use cloud when the work should keep going with the laptop closed. Cloud automations have no script mode; the prompt can tell the agent to run a script.

```bash
room-cli automation create --cloud --thread <cloudThreadId> --name "..." --prompt "..." (--cron "<expr>" --timezone <tz> | --at <datetime> | --in <duration>)
room-cli automation list --cloud [--thread <cloudThreadId>]
```

`show`, `update`, `pause`, `resume`, `run`, and `delete` take a cloud automation's ID (a UUID) without `--project`. Each cloud run is a message in its thread. A missed run fires once; a run waits until the previous one ends; three failed runs in a row pause it. Inside a Cloud thread, use `cloudroom automation` instead.

Choosing a mode:

Use `script` when the output is fully determined by code: watchdogs, threshold alerts, health checks, heartbeats, and API pollers with a fixed output shape. Scripts run on the Cloudroom server, with cwd inside the plugin data directory's `scripts/` area. Script automations do not have an environment field and do not accept environment flags.

Design the script to print nothing when there is nothing to report: an exit-0 run with empty stdout/stderr, or a last non-empty line of `{"wakeAgent": false}`, is recorded as a skipped silent tick. Any other output is captured; non-zero exit or timeout is recorded as a failed run.

Use `agent` when the run needs reasoning: summarize a feed, pick interesting items, draft a human-friendly message, or branch on content.

Creating:

```bash
room-cli automation create --project <id> --name "..." [schedule flags] [mode flags]
```

For creation flags and mode-specific defaults, read
[references/creation.md](references/creation.md).

Read `references/script-runtime.md` before you use a script file, depend on
injected variables, or diagnose retries, timeouts, restarts, and silent runs.

Managing:

```bash
room-cli automation list --project <id>
room-cli automation show <automationId> --project <id>
room-cli automation update <automationId> --project <id> [--name <name>] [schedule flags] [complete execution flags | partial agent update flags]
room-cli automation pause <automationId> --project <id>
room-cli automation resume <automationId> --project <id>
room-cli automation run <automationId> --project <id> [--idempotency-key <key>]
room-cli automation runs <automationId> --project <id> [--limit <count>] [--output <runId>]
room-cli automation delete <automationId> --project <id> --yes
```

For partial updates, mode replacement, execution targets, or damaged records,
read [references/updates.md](references/updates.md). Every command supports `--json`.
