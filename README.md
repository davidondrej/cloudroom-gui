# Cloudroom GUI

Cloudroom's desktop app, based on [BB](https://github.com/get-bb/bb). Run agents locally or connect to a compatible [Cloudroom core](https://github.com/davidondrej/cloudroom-core) for cloud execution.

This is an experimental source release. Building needs no Cloudroom account or core checkout. Using the GUI currently requires an invite-enabled Cloudroom account, including for local agents. See [release notes and compatibility](docs/releases.md).

## Security

- Your core token stays in the app's private data folder, readable only by you. It never reaches the UI or logs.
- The app only connects to remote cores over HTTPS.
- Hosted sign-in works only through cloudroom.dev. Codex and Cursor login links must point to the official OpenAI and Cursor pages.
- Other websites cannot call the app's local API.
- Cloud agents run inside the [core's security model](https://github.com/davidondrej/cloudroom-core#security).

See [cloudroom.dev/security](https://www.cloudroom.dev/security). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Build from source

Use macOS on Apple Silicon for the supported development target. Install Git, Node.js 22.19+, pnpm **9.15.0**, Python **3.11+**, and Xcode Command Line Tools for native dependencies. Keep the same Node version for installation and builds.

Run these commands from this directory:

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run build typecheck --filter=@bb/app --filter=@bb/server --filter=@bb/desktop --concurrency=2
```

Do not disable dependency install scripts: SQLite, file watching, and terminal support use native modules. If your global pnpm version differs, use `npx --yes pnpm@9.15.0` in place of `pnpm`.

## Run locally

Start the development backend and browser UI:

```sh
pnpm dev
```

In another terminal, start Electron:

```sh
pnpm exec turbo run dev --filter=@bb/desktop
```

Development uses checkout-specific ports and a separate profile. The launcher prints both. Stop each command with Ctrl-C. Local agents require their own installed, authenticated provider CLIs.

Use **Sign in** for hosted access. Cloud execution requires a matching core with `direct_workspaces` and `command_guard` capabilities; use public core [`source-2026-09-23`](https://github.com/davidondrej/cloudroom-core/releases/tag/source-2026-09-23) or newer. Manual connections use `POST /api/v1/cloudroom` with `url` and `token`, but do not bypass the GUI account requirement. Remote URLs require HTTPS. Keep tokens out of browser code, URLs, and Git.

## Checks

Use the non-interactive checks below. Desktop integration tests can launch real apps; run them only in a dedicated test environment.

```sh
pnpm exec turbo run test --filter=@bb/scripts --filter=@bb/config --concurrency=2
pnpm exec turbo run test --filter=@bb/server -- test/app/cloudroom-assets.test.ts
```

Sync and preview helpers ship in `apps/server/src/assets/cloudroom-{sync,preview}/`. Maintainers copy them from the core and verify byte-for-byte parity. They use Python's standard library.

The desktop build above creates runnable bundles, not a signed installer. Installer signing, notarization, and publication are separate steps.

## Contributing and licenses

See [CONTRIBUTING.md](CONTRIBUTING.md). Some deeper documentation and package names are inherited from BB; the commands above describe this fork.

BB's [MIT license](LICENSE) and copyright notice are retained. The bundled Cloudroom Python helpers are [Apache 2.0](apps/server/src/assets/cloudroom-sync/LICENSE). Bundled third-party notices remain with their components.
