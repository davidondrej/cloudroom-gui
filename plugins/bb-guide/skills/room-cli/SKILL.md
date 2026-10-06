---
name: room-cli
description: 'Inspect and control Cloudroom Local and Cloud threads, projects, settings, plugins, and the cloud VM with room-cli. Use for Cloudroom CLI tasks, not official BB.'
---

# Cloudroom CLI

Use `room-cli` for Cloudroom, not official BB's `bb`. Never inspect, message, or launch other threads unless the user asks.

## Check context first

```sh
room-cli status --json
```

Confirm the server URL and project/thread before acting. Standalone `room-cli` targets the installed Cloudroom backend at `http://127.0.0.1:39886`, not the cloud VM. Official BB remains separate.

Cloudroom supplies `ROOM_SERVER_URL`, `ROOM_HOST_DAEMON_PORT`, `ROOM_CLI`, `ROOM_DATA_DIR`, and thread context to Local agents and thread-scoped terminals automatically. Machine-only and environment-only terminals have no current thread. `room-cli` ignores the corresponding `BB_*` settings. Use `ROOM_*` overrides only for an intentional target change; never reuse thread IDs from another instance. `"$ROOM_CLI"` selects the current runtime's executable directly.

## Common commands

```sh
room-cli project list --json
room-cli thread list --project PROJECT --json
room-cli thread show THREAD --json
room-cli thread log THREAD
room-cli thread output THREAD
room-cli thread tell THREAD "Continue with this task"
room-cli thread stop THREAD
room-cli thread update THREAD --title "New title"
room-cli thread archive THREAD
```

"Open" or "active" threads means threads with `archivedAt: null`. An archived thread is never open or active, whatever its `status` says. `thread list` shows open threads only; `--archived` shows only archived ones, and `--include-archived` shows both.

`--self` uses `ROOM_THREAD_ID` where supported. Thread IDs select Local or Cloud execution; connection settings still point to the same GUI backend.

## Use Cloudroom from a terminal

`room-cli thread chat THREAD` turns any terminal pane (Herdr, tmux, plain shell) into a chat with a Local or Cloud thread: live output, messages, `/approve`, `/deny`, `/stop`, and `/exit`. Start a new agent in the pane with:

```sh
room-cli thread chat "$(room-cli thread spawn --project PROJECT --prompt "Task" --json | jq -r .id)"
```

Inside Herdr, `chat` shows the thread as `cloudroom` with its idle, working, or blocked state, and Herdr reopens the chat after a restart. Answer agent questions in the app or with `room-cli thread interactions`.

## Cloud threads

```sh
room-cli cloud status --json
room-cli thread spawn --project PROJECT --machine cloud --provider codex \
  --model MODEL --request-id UNIQUE_ID --prompt "Task"
```

- Supports Codex and Pi, inspection, plain-text follow-ups, stop, title changes, pinning, and archive/restore.
- `tell` queues Cloud messages automatically. Local messages still steer by default. Explicit unsupported modes fail; no fallback to Local.
- Stop pauses the Cloud queue. To resume, list it with `room-cli thread queue list THREAD`, then send its first message with `room-cli thread queue send THREAD MESSAGE_ID`.
- Read `room-cli cloud status --json` before optional Cloud operations. Steering, compaction, attachments, message editing (`rewind`), and queue editing/cancellation depend on the connected core and harness capabilities. Forks and scheduling are not enabled. The model is fixed per Cloud thread; change effort with `thread update THREAD --reasoning-level LEVEL` and read both with `thread show`. `--parent-thread` with a Cloud parent starts a linked child in that parent's sandbox. A Local parent's Cloud child (`--parent-self --machine cloud`) gets its own sandbox and messages the parent when it finishes; it starts from GitHub, so push first and pass `--base-branch BRANCH`. A capability flag is not proof that an operation completed.
- Retry an unconfirmed start with the same `--request-id`. For a rejected start, use `room-cli cloud retry-start THREAD`. Do not blindly resend uncertain work.
- To fix or set up the VM or a Cloud thread's sandbox, or move files, configs, and logins to it, use `room-cli vm run|pull|push`, with `--thread ID` for a sandbox (see the command index).
- Cloud VM agents do not get this CLI. They reach this Mac with `cloudroom mac run|pull|push`, only while "Let cloud agents access this computer" is on. They can rename, archive, or change the effort of their own thread with `cloudroom thread update --self --title TITLE`, `cloudroom thread archive --self`, and `cloudroom thread update --self --reasoning-level LEVEL`, start children in their own sandbox with `cloudroom thread spawn`, and stop or archive them with `cloudroom thread stop|archive CHILD_ID`. These commands control Cloud threads through the GUI backend while it is running.

## Verify results and Local setup

`thread wait --status idle` only checks a status. Queued work may still be waiting. Check the queue and correlate the requested task with its actual output; after compaction, verify a follow-up completes, and after an attachment upload, verify the agent can read its content.

Before a Local launch, inspect `room-cli machine provider-cli status MACHINE --json`. A cached model list does not prove the executable is installed or logged in. If Claude is installed but reports `Not logged in`, ask the user to run `claude` and `/login`; do not collect credentials or install another copy.

## References

Use `room-cli --help`, `room-cli GROUP --help`, or `room-cli guide CHAPTER` for current options. Read only the relevant reference:

- [Command index](references/command-index.md): all core command paths.
- [Thread creation](references/thread-creation.md): projects, machines, Local launches and forks.
- [Thread operation](references/thread-operation.md): inspection, messaging, queues, files, terminals.
- [Failure recovery](references/failure-recovery.md): failed/stopped Local threads and provider controls.
- [Configuration](references/configuration.md) and [app settings](references/app-settings.md): settings and environment setup.
- [Plugins](references/plugins.md): plugin management; each plugin owns its command instructions.
- [Theme commands](references/theme-commands.md) and [theming](references/theming.md): appearance.

Resolve IDs before mutation. Prefer JSON for scripts. Confirm actual results and report the ID the user needs. Never claim a queued message has completed.
