---
name: room-cli
description: 'Inspect and control Cloudroom Local and Cloud threads, projects, settings, and plugins with room. Use for Cloudroom CLI tasks, not official BB.'
---

# Room CLI

Use `room` for Cloudroom, not official BB's `bb`. Never inspect, message, or launch other threads unless the user asks.

## Check context first

```sh
room status --json
```

Confirm the server URL and project/thread before acting. Standalone `room` targets the installed Cloudroom backend at `http://127.0.0.1:39886`, not the cloud VM. Official BB remains separate.

Cloudroom supplies `ROOM_SERVER_URL`, `ROOM_HOST_DAEMON_PORT`, `ROOM_CLI`, `ROOM_DATA_DIR`, and thread context to Local agents and thread-scoped terminals automatically. Machine-only and environment-only terminals have no current thread. `room` ignores the corresponding `BB_*` settings. Use `ROOM_*` overrides only for an intentional target change; never reuse thread IDs from another instance. `"$ROOM_CLI"` selects the current runtime's executable directly.

## Common commands

```sh
room project list --json
room thread list --project PROJECT --json
room thread show THREAD --json
room thread log THREAD
room thread output THREAD
room thread tell THREAD "Continue with this task"
room thread stop THREAD
room thread update THREAD --title "New title"
room thread archive THREAD
```

`--self` uses `ROOM_THREAD_ID` where supported. Thread IDs select Local or Cloud execution; connection settings still point to the same GUI backend.

## Cloud threads

```sh
room cloudroom status --json
room thread spawn --project PROJECT --machine cloud --provider codex \
  --model MODEL --request-id UNIQUE_ID --prompt "Task"
```

- Supports Codex and Pi, inspection, plain-text follow-ups, stop, title changes, pinning, and archive/restore.
- `tell` queues Cloud messages automatically. Local messages still steer by default. Explicit unsupported modes fail; no fallback to Local.
- Stop pauses the Cloud queue. To resume, list it with `room thread queue list THREAD`, then send its first message with `room thread queue send THREAD MESSAGE_ID`.
- Read `room cloudroom status --json` before optional Cloud operations. Steering, compaction, attachments, message editing (`rewind`), and queue editing/cancellation depend on the connected core and harness capabilities. Forks/child launches, scheduling, and session-model changes are not enabled. A capability flag is not proof that an operation completed.
- Retry an unconfirmed start with the same `--request-id`. For a rejected start, use `room cloudroom retry-start THREAD`. Do not blindly resend uncertain work.
- Cloud VM agents are not automatically given this CLI or access to the Mac. These commands control Cloud threads through the GUI backend while it is running.

## Verify results and Local setup

`thread wait --status idle` only checks a status. Queued work may still be waiting. Check the queue and correlate the requested task with its actual output; after compaction, verify a follow-up completes, and after an attachment upload, verify the agent can read its content.

Before a Local launch, inspect `room machine provider-cli status MACHINE --json`. A cached model list does not prove the executable is installed or logged in. If Claude is installed but reports `Not logged in`, ask the user to run `claude` and `/login`; do not collect credentials or install another copy.

## References

Use `room --help`, `room GROUP --help`, or `room guide CHAPTER` for current options. Read only the relevant reference:

- [Command index](references/command-index.md): all core command paths.
- [Thread creation](references/thread-creation.md): projects, machines, Local launches and forks.
- [Thread operation](references/thread-operation.md): inspection, messaging, queues, files, terminals.
- [Failure recovery](references/failure-recovery.md): failed/stopped Local threads and provider controls.
- [Configuration](references/configuration.md) and [app settings](references/app-settings.md): settings and environment setup.
- [Plugins](references/plugins.md): plugin management; each plugin owns its command instructions.
- [Theme commands](references/theme-commands.md) and [theming](references/theming.md): appearance.

Resolve IDs before mutation. Prefer JSON for scripts. Confirm actual results and report the ID the user needs. Never claim a queued message has completed.
