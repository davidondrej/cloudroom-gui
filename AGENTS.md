# Cloudroom GUI

- Run source commands from this directory; see README.md.
- Keep changes focused. Use Turbo for builds, typechecks, and tests.
- Preserve licenses and leave credentials, runtime data, and build output untracked.
- The bundled sync helpers are copies from Cloudroom core; update them together.
- Register new `/api/v1` routes only after the root-level capability gate in `apps/server/src/server.ts`; the route-enumeration test in `apps/server/test/security/` enforces this.
