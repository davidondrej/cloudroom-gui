# ROLE
- Help David build and ship a simple, reliable product.
- Be proactive. When the next step is clear, safe, and authorized, do it.
- Finish the change, verify it, and fix failures it causes.

## RESPONSE STYLE
- Use short sentences, plain English, and clean Markdown.
- Be concise. Explain important tradeoffs without burying the answer.

## SIMPLICITY
- Prefer fewer files, dependencies, and abstractions.
- Reuse existing patterns. Do not build for hypothetical needs.
- Keep code and docs small, readable, and easy to maintain.
- Validate inputs at boundaries; use typed values internally.
- No code comments except tool directives and Plugin SDK declarations.

## KEY FILES & FOLDERS
- [Repo map](docs/repository-overview.md): apps, packages, and their roles.
- [Architecture](docs/system-overview.md): how the system fits together.
- [Cloudroom](apps/server/src/services/cloudroom/AGENTS.md): integration rules.
- [Local QA](docs/debugging-and-qa.md): dev setup, logs, and verification.
- [CLI guide](docs/cli-guide-and-skill.md): docs to update for CLI and config changes.
- [Plugin API audit](docs/api_to_audit.md): experimental APIs and stabilization.
- Read the relevant docs and child `AGENTS.md` before changing an area.

## CONTRACTS
- The server owns product policy. The host daemon owns local execution.
- Bump `HOST_DAEMON_PROTOCOL_VERSION` for wire-contract changes unless backward compatibility is deliberate and tested.
- Ship user features through the UI, SDK, and `bb` CLI together.
- New public plugin APIs need `experimental_`, an audit entry, and Plugin Guide registration in `packages/plugin-api-map/src/surfaces.ts`.
- When renaming a concept, update code, tests, and docs across the repo.

## UI & DATA
- Use shared UI components, typography tokens, and theme-derived colors.
- Use the persistent responsive drawer, not modals that disable the app root. Verify drawer changes in iOS Safari.
- Never use CSS `@scope`; use the existing `:where()` scoping pattern.
- Query only the data needed. Regenerate Drizzle migrations; never hand-edit snapshots.
- Never mock the database. Use an in-memory database with real migrations.

## VERIFICATION
- From `gui/`: `pnpm install --frozen-lockfile`; `pnpm exec turbo run build typecheck --filter=@bb/app --filter=@bb/server --filter=@bb/desktop --concurrency=2`; `pnpm exec turbo run test --filter=@bb/scripts --filter=@bb/config --concurrency=2`. Dated suite limitations are in the [cutover record](../archive/docs/development-cutover.md#step-4-verification).
- Run builds, typechecks, and tests through Turbo: `pnpm exec turbo run <task> --filter=<package>`.
- Test real behavior and plausible failures, not trivial wiring.
- Use `sharedWorkerProjects` from `vitest.shared.ts`; isolate tests that mutate globals.
- Keep generated files untracked. Give generators explicit Turbo inputs, outputs, and dependencies.
- Check the diff. Leave unrelated work alone. Stop once relevant checks pass.

## ISSUES & PRS
- Debug from observed logs, APIs, and database state, not guesses.
- Follow the [issue guide](docs/filing-issues.md) and [PR template](.github/PULL_REQUEST_TEMPLATE.md).
- End agent-created issue and PR bodies with `> AGENT GENERATED`.
