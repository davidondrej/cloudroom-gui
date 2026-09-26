---
name: cloudroom
description: 'Inspect and control Cloudroom Local and Cloud threads, projects, settings, plugins, and the cloud VM with the cloudroom CLI. Use for Cloudroom CLI tasks, not official BB.'
---

# Cloudroom CLI

Use `cloudroom` for Cloudroom, not official BB's `bb`. Never inspect, message, or launch other threads unless the user asks.

## Check context first

```sh
cloudroom status --json
```

Confirm the server URL and project/thread before acting. Standalone `cloudroom` targets the installed Cloudroom backend at `http://127.0.0.1:39886`, not the cloud VM. Official BB remains separate.

Cloudroom supplies `ROOM_SERVER_URL`, `ROOM_HOST_DAEMON_PORT`, `ROOM_CLI`, `ROOM_DATA_DIR`, and thread context to Local agents and thread-scoped terminals automatically. Machine-only and environment-only terminals have no current thread. `cloudroom` ignores the corresponding `BB_*` settings. Use `ROOM_*` overrides only for an intentional target change; never reuse thread IDs from another instance. `"$ROOM_CLI"` selects the current runtime's executable directly.

## Common commands

```sh
cloudroom project list --json
cloudroom thread list --project PROJECT --json
cloudroom thread show THREAD --json
cloudroom thread log THREAD
cloudroom thread output THREAD
cloudroom thread tell THREAD "Continue with this task"
cloudroom thread stop THREAD
cloudroom thread update THREAD --title "New title"
cloudroom thread archive THREAD
```

"Open" or "active" threads means threads with `archivedAt: null`. An archived thread is never open or active, whatever its `status` says. `thread list` shows open threads only; `--archived` shows only archived ones, and `--include-archived` shows both.

`--self` uses `ROOM_THREAD_ID` where supported. Thread IDs select Local or Cloud execution; connection settings still point to the same GUI backend.

## Cloud threads

```sh
cloudroom cloud status --json
cloudroom thread spawn --project PROJECT --machine cloud --provider codex \
  --model MODEL --request-id UNIQUE_ID --prompt "Task"
```

- Supports Codex and Pi, inspection, plain-text follow-ups, stop, title changes, pinning, and archive/restore.
- `tell` queues Cloud messages automatically. Local messages still steer by default. Explicit unsupported modes fail; no fallback to Local.
- Stop pauses the Cloud queue. To resume, list it with `cloudroom thread queue list THREAD`, then send its first message with `cloudroom thread queue send THREAD MESSAGE_ID`.
- Read `cloudroom cloud status --json` before optional Cloud operations. Steering, compaction, attachments, message editing (`rewind`), and queue editing/cancellation depend on the connected core and harness capabilities. Forks/child launches, scheduling, and session-model changes are not enabled. A capability flag is not proof that an operation completed.
- Retry an unconfirmed start with the same `--request-id`. For a rejected start, use `cloudroom cloud retry-start THREAD`. Do not blindly resend uncertain work.
- To fix or set up the VM itself, or move files, configs, and logins to it, use `cloudroom vm run|pull|push` (see the command index).
- Cloud VM agents do not get this CLI. They reach this Mac with `cloudroom mac run|pull|push`, only while "Let cloud agents access this computer" is on. They can rename or archive their own thread with `cloudroom thread update --self --title TITLE` and `cloudroom thread archive --self`. These commands control Cloud threads through the GUI backend while it is running.

## Verify results and Local setup

`thread wait --status idle` only checks a status. Queued work may still be waiting. Check the queue and correlate the requested task with its actual output; after compaction, verify a follow-up completes, and after an attachment upload, verify the agent can read its content.

Before a Local launch, inspect `cloudroom machine provider-cli status MACHINE --json`. A cached model list does not prove the executable is installed or logged in. If Claude is installed but reports `Not logged in`, ask the user to run `claude` and `/login`; do not collect credentials or install another copy.

## References

Use `cloudroom --help`, `cloudroom GROUP --help`, or `cloudroom guide CHAPTER` for current options. Read only the relevant reference:

- [Command index](references/command-index.md): all core command paths.
- [Thread creation](references/thread-creation.md): projects, machines, Local launches and forks.
- [Thread operation](references/thread-operation.md): inspection, messaging, queues, files, terminals.
- [Failure recovery](references/failure-recovery.md): failed/stopped Local threads and provider controls.
- [Configuration](references/configuration.md) and [app settings](references/app-settings.md): settings and environment setup.
- [Plugins](references/plugins.md): plugin management; each plugin owns its command instructions.
- [Theme commands](references/theme-commands.md) and [theming](references/theming.md): appearance.

Resolve IDs before mutation. Prefer JSON for scripts. Confirm actual results and report the ID the user needs. Never claim a queued message has completed.
