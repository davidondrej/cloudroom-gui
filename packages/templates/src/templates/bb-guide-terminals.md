---
kind: instruction
title: Room Terminal Guide
summary: Creating and managing persistent terminals across thread, environment, and machine scopes.
intent: Help agents route terminal sessions explicitly and manage them by terminal ID.
editingNotes: Keep scope selectors and ID-only commands aligned with room terminal --help.
---
Terminal commands

Use terminals for long-running commands that should stay alive for the user,
such as dev servers, watch tasks, REPLs, and database consoles. A terminal is a
real persistent PTY and appears in the Room UI.

List and create require exactly one explicit scope:

  room terminal list --thread <thread-id>
  room terminal list --environment <environment-id>
  room terminal list --machine <id-or-name> [--cwd <path>]

  room terminal create --thread <thread-id> --command "pnpm dev"
  room terminal create --environment <environment-id>
  room terminal create --machine <id-or-name> [--cwd <path>]
    --host <id-or-name>                   Alias for --machine
    --title <title>                       Display title
    --cols <n>                            Initial terminal columns
    --rows <n>                            Initial terminal rows
    --attach                              Attach after creating
    --json                                Print machine-readable output

Machine names are resolved to an explicit machine ID. No scope defaults to the
primary machine, and --cwd is valid only with --machine or --host.

Thread-scoped terminals receive ROOM_THREAD_ID, ROOM_PROJECT_ID,
ROOM_ENVIRONMENT_ID, and ROOM_THREAD_STORAGE. Use room status or --self
without setting context manually. Environment-only and machine-only terminals
have no current thread and do not inherit another thread's context.

All other operations need only the terminal ID:

  room terminal show <terminal-id>
  room terminal attach <terminal-id>        Ctrl-B d detaches
  room terminal send <terminal-id> --text <text> [--enter]
    --stdin                               Read bytes from stdin instead of --text
  room terminal resize <terminal-id> --cols <n> --rows <n>
  room terminal rename <terminal-id> <title>
  room terminal restart <terminal-id>       Atomically replaces it with a shell; does not replay the original command
  room terminal close <terminal-id> [--if-clean]

  room terminal output <terminal-id>
    --since-seq <n>                       Read output chunks from a sequence
    --tail-bytes <n>                      Bound output to latest N bytes
    --limit-chunks <n>                    Bound output to latest N chunks
    --json                                Print chunks, nextSeq, and truncated

  room terminal wait <terminal-id>
    --contains <text>                     Wait for new output containing text
    --regex <pattern>                     Wait for new output matching regex
    --exit                                Wait until the terminal exits
    --from-start                          Include existing scrollback
    --timeout <seconds>                   Timeout
    --poll-interval <ms>                  Polling interval

For a dev server, prefer:

  room terminal create --thread <thread-id> --title "pnpm dev" --command "pnpm dev"
  room terminal wait <terminal-id> --contains "Local:" --timeout 120

Do not run long-lived servers as one-off foreground commands when the user will
need to inspect logs, refresh the page, or stop the process later.
