Cloudroom Connect opens Cloudroom from a phone or another computer. It is powered by BB Connect. Your private `https://<handle>.getbb.app` address requires your BB Connect account login.

## What you get

- Remote access through an outbound tunnel. No router changes or open inbound ports.
- Port shares for local HTTP servers, accessible to viewers signed in to your account.
- The Cloudroom mobile app: open your remote URL in Safari or Chrome, then use Add to Home Screen or Install app. This is the PWA, not BB's native mobile app.
- Connection status, your remote URL, and a sidebar shortcut in Cloudroom Connect settings.

## Setup and commands

Get a code from the getbb.app dashboard and enter it in Settings → Cloudroom Connect, or run `cloudroom connect --code <code> --server <url>`. The tunnel reconnects after a drop. Disable the plugin to stop remote access; `cloudroom connect off` also forgets the pairing.

Agents use `cloudroom connect expose <port>` to share previews. Inspect with `cloudroom connect status`, `cloudroom connect shares`, and `cloudroom connect servers`; stop a share with `cloudroom connect unexpose <port>`.

Existing native-device enrollment remains available through `cloudroom connect machine-code` for compatibility. The PWA uses browser login and does not need that command or a native pairing code.
