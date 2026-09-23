Keep a Claude Code or Codex thread running when one account hits its limit. A local hub picks one of your accounts for each request.

## What you get

- A pool of Claude and Codex accounts, added by importing the login already on the machine, signing in through the browser, or pasting an Anthropic API key.
- Accounts run one after another in priority order, with ties following the order added. New conversations stay on the current fallback even when an earlier account recovers. Existing conversations keep their own account until it becomes unavailable.
- Drag handles set the account order within each provider in settings (keyboard: Space to pick up, arrow keys to move, Space to drop, Escape to cancel), with the same operation available through `room pool account reorder <claude|codex> <id>...`.
- Live limit windows per account and model family in the plugin's settings page, and the same numbers from `room pool status`.
- A routing switch per provider and a bypass per thread, so one thread can go straight to its own credentials.
- Opt-in cache miss reports, analyzed after each response ends, that name the likely cause of a large miss and the first changed prompt segment.

## How it works

The hub runs inside Room and serves an Anthropic Messages endpoint and an OpenAI Responses endpoint. With routing on, Room hands the Claude Code or Codex process a base URL that points at the hub and a token scoped to that machine, and the provider reports **Proxied** in its health row. An account is skipped for a request when it is at or above the switch threshold or in error. The threshold defaults to 98 percent of a window. Account secrets stay in the Room data directory on the server machine, and the hub refreshes them in the background.

The pool waits once on the same account for short temporary rate limits. Longer holds return Retry-After for pinned conversations while new conversations can advance. A model-family limit detours requests for that family without moving the session’s main pin or the provider cursor. The pool commits a new account after a successful response; a failed attempt across every account retains the previous binding. The current account and session pins survive hub restarts. Session pins expire after 30 idle minutes, with the 4,096 most recently used pins retained.

The pooler owns its upstream HTTP connections and uses HTTP/1.1, so a broken HTTP/2 session in the server's shared fetch dispatcher does not strand pooled requests. The transport honors standard proxy environment variables and is disposed on plugin unload. This does not add request replay; existing account-fallback rules still apply. Pooled request connection failures log a known error code when available, without request bodies, credentials, URLs, or raw exception messages.

## Nested Room servers

A Room server started inside another Room server's thread detects the parent's pooler and enables this plugin. Choose in settings or with `room pool parent`:

- **proxy** (default): keep a local hub with its own machine tokens and forward pooled traffic to the parent, so the parent's token never reaches this server's agents. Routing is contributed only for providers the parent can serve.
- **isolate**: neutralise the inherited routing and use this instance's own accounts, or each provider's own credentials.

Proxied traffic authenticates as the parent machine's token, so the parent attributes it to itself.

## Requirements

Accounts you own and are permitted to use this way.

This plugin is experimental. Routing behavior, stored data, and the CLI can change between releases.

## For agents

`room pool account add|list|remove|enable|disable|priority|reorder`, `room pool status`, `room pool routing <claude|codex> [--off]`, `room pool config`, `room pool config set`, `room pool cache-miss list|clear`, `room pool parent [proxy|isolate]`, `room pool token rotate`, and `room pool bypass <thread-id>`. `list` and `status` take `--json`.
