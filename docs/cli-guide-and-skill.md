# CLI, Guide, And Skill

Keep the discoverable surfaces in sync whenever you add or change a `cloudroom` CLI command, flag, or a user-facing configuration knob (env var, `.bb/` workspace file, settings field):

- Update the in-CLI guide templates under `packages/templates/src/templates/bb-guide-*.md`, turbo regenerates `packages/templates/src/generated/templates.generated.ts` (not committed) before every build, typecheck, and test task.
- For core commands, update the cloudroom skill at `plugins/bb-guide/skills/cloudroom/SKILL.md` or its relevant reference. For plugin commands and settings, update the owning plugin's `skills/<name>/SKILL.md` or supporting reference, including built-in plugins. Keep plugin-specific behavior out of the core CLI skill. Configuration knobs also belong in `docs/configuration.md`.
- Match the existing chapter/section style; keep entries concise and accurate against the implementation.

Environment lifecycle hooks are core policy: cloudroom runs `.bb-env-setup.sh` after
an environment provider creates an owned path, and `.bb-env-teardown.sh` before
provider removal. Each has a 15-minute timeout; setup failure fails provisioning,
while reported teardown script failure does not block removal. Transport failure
keeps cleanup pending until the daemon confirms hook termination. Hook identity
and completion persist across server restarts. Attached checkout and
personal-workspace paths skip both hooks. These semantics apply equally to CLI,
SDK, and app launches; see [worktrees.md](worktrees.md).

The Machines settings creation drawer prepares an existing-machine command when access is ready, otherwise shows setup guidance. After access is ready, Choose a machine provider reviews provider inputs and launches through `hosts.experimental_create`/`cloudroom machine create`. A machine belongs to no project; projects reach it later through project sources.

`cloudroom machine list` enumerates persistent machines and takes `--all` to include
disposable provider sandboxes, matching the app's Show all machines reveal.
`cloudroom updates` and `cloudroom skill install-cli-skills` default to persistent machines
and still accept a sandbox through an explicit `--machine`.

Machine maintenance state is part of `cloudroom machine list --json`; there is no
separate machine lifecycle command. Keep the machine guide and cloudroom command
index aligned with this surface.

Local installed-daemon start, stop, and uninstall operations are flags on
`install-machine.sh`, not `cloudroom machine` subcommands.

Modal connection and machine commands are documented in [modal-sandboxes](../plugins/environment-modal-sandbox/skills/modal-sandboxes/SKILL.md). `cloudroom modal image show [--json]` reads the Dockerfile shown in settings; `cloudroom modal image set --file PATH [--json]` saves a validated plugin-wide override and `cloudroom modal image reset [--json]` restores the bundled default for future machines; `cloudroom modal account inspect --json` checks credentials; `cloudroom machine create --provider modal-sandbox --json` automatically prepares the bundled image and installs the daemon. `cloudroom machine remove MACHINE --yes` explicitly removes compute and private snapshots.

`cloudroom thread spawn --machine-inputs <json>` configures either an explicit
`--new-machine` or the machine provider owned by a composed
`--environment-provider`; a composition rejects separate machine selectors.

Modal image debugging uses `cloudroom modal image build`, `cloudroom modal sandbox run`, `cloudroom modal sandbox exec ID [--json] -- COMMAND...`, and `cloudroom modal sandbox stop ID`. Debug compute expires after 30 minutes and skips BB enrollment and project setup. See the plugin skill for output limits and typed RPC equivalents.
