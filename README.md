# Cloudroom GUI

Cloudroom's desktop app, based on [BB](https://github.com/get-bb/bb). Run agents locally or connect to a compatible [Cloudroom core](https://github.com/davidondrej/cloudroom-core) for cloud execution.

This is an experimental developer build. Hosted cloud access is invite-only. Building the GUI does not require the core checkout, a Cloudroom account, or cloud credentials.

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

Cloud execution requires a compatible running core, not its source files. Use **Sign in** for hosted access. Self-hosted connections use `POST /api/v1/cloudroom` with `url` and `token`; remote URLs require HTTPS. Keep tokens out of browser code, URLs, and Git. Public core releases may lag GUI development, so confirm API compatibility before connecting.

## Security boundary

The local server's `/api/v1` API and browser WebSocket are served for the local app only. **Origin checks are CSRF hardening, not authentication** — they do not identify the caller, and requests without an `Origin` header (curl, CLIs, SDKs) are accepted. Two controls harden this boundary; both default off for loopback operation:

- **Non-loopback binding is refused at startup.** `BB_SERVER_BIND_HOST=0.0.0.0` fails with a fatal error unless `BB_SERVER_ALLOW_NON_LOOPBACK=1` is set explicitly. The Connect gateway is the supported remote-access path; this flag only unblocks development proxies and must never be used to expose the API to a network.
- **Per-install capability token.** Set `BB_REQUIRE_PUBLIC_API_CAPABILITY=1` to require the token on every `/api/v1` request and WebSocket upgrade (`x-bb-capability: <token>` or `Authorization: Bearer <token>`). The token is auto-generated in `<BB_DATA_DIR>/public-api-capability` with `0600` permissions. Enable this when untrusted local processes could reach the port.

The host daemon and Connect connections have their own authentication (bearer keys, signed sessions) and are unaffected by these flags.

## Checks

The 18 script-suite failures from the initial alpha are fixed. The standalone build, typechecks, configuration and scripts suites, and bundled-helper tests pass.

```sh
pnpm exec turbo run test --filter=@bb/scripts --filter=@bb/config --concurrency=2
pnpm exec turbo run test --filter=@bb/server -- test/app/cloudroom-assets.test.ts
```

The sync helper ships in `apps/server/src/assets/cloudroom-sync/`. Both source and bundled builds use that copy. Maintainers update it from the core; the development repository checks that the copies match. It needs no third-party Python packages.

The desktop build above creates runnable bundles, not a signed installer. Installer signing, notarization, and publication are separate steps.

## Contributing and licenses

See [CONTRIBUTING.md](CONTRIBUTING.md). Some deeper documentation and package names are inherited from BB; the commands above describe this fork.

BB's [MIT license](LICENSE) and copyright notice are retained. The bundled Cloudroom Python helpers are [Apache 2.0](apps/server/src/assets/cloudroom-sync/LICENSE). Bundled third-party notices remain with their components.
