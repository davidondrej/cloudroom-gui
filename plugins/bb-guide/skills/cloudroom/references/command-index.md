# Core command index

This index lists every command path that the core CLI registers. Read the task-specific reference before you use a command. Check live help for flags and defaults.

## cloud

- `cloudroom cloud`
- `cloudroom cloud status`
- `cloudroom cloud sign-in`
- `cloudroom cloud cancel`
- `cloudroom cloud logout`
- `cloudroom cloud codex`
- `cloudroom cloud codex status`
- `cloudroom cloud codex login`
- `cloudroom cloud codex cancel`
- `cloudroom cloud cursor`
- `cloudroom cloud cursor status`
- `cloudroom cloud cursor login`
- `cloudroom cloud cursor cancel`
- `cloudroom cloud cursor key`
- `cloudroom cloud pi key PROVIDER` (reads the key from stdin)
- `cloudroom cloud teleport`
- `cloudroom cloud retry-start`
- `cloudroom cloud thread-workspace`

`sign-in --project ID` prints the browser link for connecting the account's existing VM. `--website-url http://127.0.0.1:PORT` is for local website development. All commands accept `--json`. Logout removes this app's VM credentials, not remote jobs or local history. Existing cloud bindings block switching to another account/core. `retry-start` retries a rejected launch with its saved prompt and original request ID; it never reruns an existing cloud session.

`thread-workspace` reads the thread's live cloud directory, branch, and commit. An unavailable core never falls back to the local checkout.

## vm

- `cloudroom vm`
- `cloudroom vm run`
- `cloudroom vm pull`
- `cloudroom vm push`

`cloudroom vm run 'COMMAND' [--cwd DIR] [--stdin]`, `vm pull VM_PATH [LOCAL_FOLDER]`, and `vm push LOCAL_PATH [VM_FOLDER]` run commands and copy files on the signed-in VM as its agent account, in the agent home by default. `run` exits with the command's code. Copies are tar archives, limited to 16 MiB compressed. `~` means the VM agent home.

## import

- `cloudroom import`
- `cloudroom import bb`

`import bb` copies every open BB thread into an idle Local thread with its full history, title, harness, and model. It forks each native session, so it sends no prompts and never changes BB. Re-running skips threads already imported.

## status

- `cloudroom status`

## settings

- `cloudroom settings`
- `cloudroom settings show`
- `cloudroom settings ai-services`
- `cloudroom settings general`
- `cloudroom settings completed-turns`
- `cloudroom settings experiment`
- `cloudroom settings keyboard`
- `cloudroom settings keyboard hints`
- `cloudroom settings keyboard list`
- `cloudroom settings keyboard set`
- `cloudroom settings keyboard reset`
- `cloudroom settings ui`
- `cloudroom settings ui list`
- `cloudroom settings ui get`
- `cloudroom settings ui set`
- `cloudroom settings ui reset`
- `cloudroom settings usage`
- `cloudroom settings version`
- `cloudroom settings reload`

## project

- `cloudroom project`
- `cloudroom project source`
- `cloudroom project source add`
- `cloudroom project source update`
- `cloudroom project source delete`
- `cloudroom project attachment`
- `cloudroom project attachment upload`
- `cloudroom project attachment download`
- `cloudroom project list`
- `cloudroom project history`
- `cloudroom project reorder`
- `cloudroom project branches`
- `cloudroom project paths`
- `cloudroom project commands`
- `cloudroom project files`
- `cloudroom project content`
- `cloudroom project create`
- `cloudroom project show`
- `cloudroom project update`
- `cloudroom project delete`

`cloudroom project show <id>` accepts `proj_personal` to inspect Personal.

## provider

- `cloudroom provider`
- `cloudroom provider list`
- `cloudroom provider models`

## manager

- `cloudroom manager`
- `cloudroom manager hire`
- `cloudroom manager list`
- `cloudroom manager status`
- `cloudroom manager delete`

## machine

- `cloudroom machine`
- `cloudroom machine providers`
- `cloudroom machine enroll`
- `cloudroom machine env`
- `cloudroom machine env list`
- `cloudroom machine env set`
- `cloudroom machine env unset`
- `cloudroom machine create`
- `cloudroom machine list`
- `cloudroom machine show`
- `cloudroom machine join-code`
- `cloudroom machine rename`
- `cloudroom machine remove`
- `cloudroom machine suspend`
- `cloudroom machine resume`
- `cloudroom machine reconcile`
- `cloudroom machine retry-cleanup`
- `cloudroom machine retry-update`
- `cloudroom machine provider-cli`
- `cloudroom machine provider-cli status`
- `cloudroom machine provider-cli install`

`cloudroom thread spawn --new-machine <provider-id>` creates a machine for a new
environment and requires `--environment-provider <id>`. For a composed option,
use `--environment-provider modal-sandbox` alone. `--machine-inputs <json>`
configures the machine with optional configured `preset` and `image` names;
`--environment-inputs <json>` configures the workspace. Neither carries secrets.

## updates

- `cloudroom updates`
- `cloudroom updates status`
- `cloudroom updates apply`

## terminal

- `cloudroom terminal`
- `cloudroom terminal list`
- `cloudroom terminal create`
- `cloudroom terminal start`
- `cloudroom terminal show`
- `cloudroom terminal attach`
- `cloudroom terminal send`
- `cloudroom terminal resize`
- `cloudroom terminal output`
- `cloudroom terminal wait`
- `cloudroom terminal rename`
- `cloudroom terminal restart`
- `cloudroom terminal close`
- `cloudroom terminal stop`

## thread

- `cloudroom thread`
- `cloudroom thread wait`
- `cloudroom thread spawn`
- `cloudroom thread fork`
- `cloudroom thread list`
- `cloudroom thread show`
- `cloudroom thread log`
- `cloudroom thread output`
- `cloudroom thread open`
- `cloudroom thread pane`
- `cloudroom thread section`
- `cloudroom thread section list`
- `cloudroom thread section create`
- `cloudroom thread section rename`
- `cloudroom thread section delete`
- `cloudroom thread search`
- `cloudroom thread history`
- `cloudroom thread read`
- `cloudroom thread unread`
- `cloudroom thread reorder-pinned`
- `cloudroom thread count`
- `cloudroom thread queue`
- `cloudroom thread queue list`
- `cloudroom thread queue create`
- `cloudroom thread queue update`
- `cloudroom thread queue send`
- `cloudroom thread queue delete`
- `cloudroom thread queue reorder`
- `cloudroom thread queue group`
- `cloudroom thread tabs`
- `cloudroom thread tabs show`
- `cloudroom thread tabs set`
- `cloudroom thread update`
- `cloudroom thread archive`
- `cloudroom thread unarchive`
- `cloudroom thread pin`
- `cloudroom thread unpin`
- `cloudroom thread delete`
- `cloudroom thread edit-message`
- `cloudroom thread tell`
- `cloudroom thread retry`
- `cloudroom thread stop`
- `cloudroom thread compact`
- `cloudroom thread context`
- `cloudroom thread clear`
- `cloudroom thread cancel-plan`
- `cloudroom thread clear-goal`
- `cloudroom thread interactions`
- `cloudroom thread interactions list`
- `cloudroom thread interactions show`
- `cloudroom thread interactions approve`
- `cloudroom thread interactions grant`
- `cloudroom thread interactions answer`
- `cloudroom thread interactions respond`
- `cloudroom thread interactions deny`

## environment

- `cloudroom environment`
- `cloudroom environment providers`
- `cloudroom environment list`
- `cloudroom environment delete`
- `cloudroom environment show`
- `cloudroom environment status`
- `cloudroom environment branches`
- `cloudroom environment paths`
- `cloudroom environment diff`
- `cloudroom environment diff-files`
- `cloudroom environment diff-file`
- `cloudroom environment diff-patch`
- `cloudroom environment update`
- `cloudroom environment commit`
- `cloudroom environment archive-threads`
- `cloudroom environment pull-request`
- `cloudroom environment pull-request show`
- `cloudroom environment pull-request ready`
- `cloudroom environment pull-request draft`
- `cloudroom environment pull-request merge`

## file

- `cloudroom file`
- `cloudroom file read`
- `cloudroom file write`
- `cloudroom file list`
- `cloudroom file paths`
- `cloudroom file mkdir`
- `cloudroom file move`
- `cloudroom file remove`

## theme

- `cloudroom theme`
- `cloudroom theme list`
- `cloudroom theme set`
- `cloudroom theme dir`
- `cloudroom theme favicon`
- `cloudroom theme favicon set`
- `cloudroom theme favicon reset`
- `cloudroom theme show`
- `cloudroom theme reset`

## plugin

- `cloudroom plugin`
- `cloudroom plugin search`
- `cloudroom plugin list`
- `cloudroom plugin source`
- `cloudroom plugin install`
- `cloudroom plugin outdated`
- `cloudroom plugin update`
- `cloudroom plugin new`
- `cloudroom plugin types`
- `cloudroom plugin migrate`
- `cloudroom plugin build`
- `cloudroom plugin dev`
- `cloudroom plugin reload`
- `cloudroom plugin rpc`
- `cloudroom plugin rpc list`
- `cloudroom plugin rpc inspect`
- `cloudroom plugin rpc call`
- `cloudroom plugin enable`
- `cloudroom plugin disable`
- `cloudroom plugin config`
- `cloudroom plugin token`
- `cloudroom plugin run`
- `cloudroom plugin logs`
- `cloudroom plugin remove`

## marketplace

- `cloudroom marketplace`
- `cloudroom marketplace add`
- `cloudroom marketplace list`
- `cloudroom marketplace refresh`
- `cloudroom marketplace remove`

## skill

- `cloudroom skill`
- `cloudroom skill list`
- `cloudroom skill show`
- `cloudroom skill files`
- `cloudroom skill update`
- `cloudroom skill delete`
- `cloudroom skill search`
- `cloudroom skill registry`
- `cloudroom skill registry detail`
- `cloudroom skill install`
- `cloudroom skill cli-skills-status`
- `cloudroom skill install-cli-skills`

## guide

- `cloudroom guide`

## voice

- `cloudroom voice`
- `cloudroom voice transcribe`

## browser

- `cloudroom browser`
- `cloudroom browser instances`
- `cloudroom browser tabs`
- `cloudroom browser create`
- `cloudroom browser acquire`
- `cloudroom browser connection`
- `cloudroom browser release`
- `cloudroom browser reveal`
- `cloudroom browser close`
- `cloudroom browser capture`
- `cloudroom browser watch`
- `cloudroom browser import-sources`
- `cloudroom browser import-cookies`

Machine lists and name/ID selectors include machines still being created. Machine creation is durable: `create --no-wait` returns the creating host ID. `machine show <host-id>` reads progress and `machine remove <host-id>` cancels it. SIGINT only stops following.

Machine environment: `cloudroom machine env list`, `cloudroom machine env set NAME`
(value from stdin), and `cloudroom machine env unset NAME`; all accept `--json`.

Standalone `cloudroom machine create` machines remain until explicitly removed.
