Cloudroom Connect opens Cloudroom from your phone or another computer, at a private `https://<id>.cloudroom.run` address. It runs on Cloudroom's own relay ([ADR 0184](../../../docs/adr/0184-own-the-mobile-connection.md)).

## What you get

- Remote access through an outbound tunnel. No router changes or open inbound ports.
- One-code setup: open cloudroom.dev/mobile on your phone and enter the code from Settings → Cloudroom Connect. No extra account or login.
- Port shares for local HTTP servers, open only on your signed-in phones and browsers.
- The Cloudroom mobile app: after signing in, use Add to Home Screen or Install app. This is the PWA, not BB's native mobile app.

## Setup and commands

Connect registers this Mac by itself once you are signed in to Cloudroom. Get a phone code in Settings → Cloudroom Connect, or run `room-cli connect phone-code`. Phones stay signed in until `room-cli connect sign-out-phones` or Sign out all phones. Disable the plugin to stop remote access.

Agents use `room-cli connect expose <port>` to share previews. Inspect with `room-cli connect status` and `room-cli connect shares`; stop a share with `room-cli connect unexpose <port>`.

Old getbb.app pairings keep working until December 7, 2026. `room-cli connect off` turns the old link off; `servers` and `machine-code` only apply to it.
