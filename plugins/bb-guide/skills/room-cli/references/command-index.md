# Core command index

This index lists every command path that the core CLI registers. Read the task-specific reference before you use a command. Check live help for flags and defaults.

## cloudroom

- `room cloudroom`
- `room cloudroom status`
- `room cloudroom sign-in`
- `room cloudroom cancel`
- `room cloudroom logout`
- `room cloudroom retry-start`
- `room cloudroom workspace`
- `room cloudroom prepare`
- `room cloudroom thread-workspace`

`sign-in --project ID` prints the browser link for connecting the account's existing VM. `--website-url http://127.0.0.1:PORT` is for local website development. All commands accept `--json`. Logout removes this app's VM credentials, not remote jobs or local history. Existing cloud bindings block switching to another account/core. `retry-start` retries a rejected launch with its saved prompt and original request ID; it never reruns an existing cloud session.

`thread-workspace` reads the thread's live cloud directory, branch, and commit. An unavailable core never falls back to the local checkout.

## status

- `room status`

## settings

- `room settings`
- `room settings show`
- `room settings ai-services`
- `room settings general`
- `room settings completed-turns`
- `room settings experiment`
- `room settings keyboard`
- `room settings keyboard hints`
- `room settings keyboard list`
- `room settings keyboard set`
- `room settings keyboard reset`
- `room settings ui`
- `room settings ui list`
- `room settings ui get`
- `room settings ui set`
- `room settings ui reset`
- `room settings usage`
- `room settings version`
- `room settings reload`

## project

- `room project`
- `room project source`
- `room project source add`
- `room project source update`
- `room project source delete`
- `room project attachment`
- `room project attachment upload`
- `room project attachment download`
- `room project list`
- `room project history`
- `room project reorder`
- `room project branches`
- `room project paths`
- `room project commands`
- `room project files`
- `room project content`
- `room project create`
- `room project show`
- `room project update`
- `room project delete`

`room project show <id>` accepts `proj_personal` to inspect Personal.

## provider

- `room provider`
- `room provider list`
- `room provider models`

## manager

- `room manager`
- `room manager hire`
- `room manager list`
- `room manager status`
- `room manager delete`

## machine

- `room machine`
- `room machine providers`
- `room machine enroll`
- `room machine env`
- `room machine env list`
- `room machine env set`
- `room machine env unset`
- `room machine create`
- `room machine list`
- `room machine show`
- `room machine join-code`
- `room machine rename`
- `room machine remove`
- `room machine suspend`
- `room machine resume`
- `room machine reconcile`
- `room machine retry-cleanup`
- `room machine retry-update`
- `room machine provider-cli`
- `room machine provider-cli status`
- `room machine provider-cli install`

`room thread spawn --new-machine <provider-id>` creates a machine for a new
environment and requires `--environment-provider <id>`. For a composed option,
use `--environment-provider modal-sandbox` alone. `--machine-inputs <json>`
configures the machine with optional configured `preset` and `image` names;
`--environment-inputs <json>` configures the workspace. Neither carries secrets.

## updates

- `room updates`
- `room updates status`
- `room updates apply`

## terminal

- `room terminal`
- `room terminal list`
- `room terminal create`
- `room terminal start`
- `room terminal show`
- `room terminal attach`
- `room terminal send`
- `room terminal resize`
- `room terminal output`
- `room terminal wait`
- `room terminal rename`
- `room terminal restart`
- `room terminal close`
- `room terminal stop`

## thread

- `room thread`
- `room thread wait`
- `room thread spawn`
- `room thread fork`
- `room thread list`
- `room thread show`
- `room thread log`
- `room thread output`
- `room thread open`
- `room thread pane`
- `room thread section`
- `room thread section list`
- `room thread section create`
- `room thread section rename`
- `room thread section delete`
- `room thread search`
- `room thread history`
- `room thread read`
- `room thread unread`
- `room thread reorder-pinned`
- `room thread count`
- `room thread queue`
- `room thread queue list`
- `room thread queue create`
- `room thread queue update`
- `room thread queue send`
- `room thread queue delete`
- `room thread queue reorder`
- `room thread queue group`
- `room thread tabs`
- `room thread tabs show`
- `room thread tabs set`
- `room thread update`
- `room thread archive`
- `room thread unarchive`
- `room thread pin`
- `room thread unpin`
- `room thread delete`
- `room thread edit-message`
- `room thread tell`
- `room thread retry`
- `room thread stop`
- `room thread compact`
- `room thread context`
- `room thread clear`
- `room thread cancel-plan`
- `room thread clear-goal`
- `room thread interactions`
- `room thread interactions list`
- `room thread interactions show`
- `room thread interactions approve`
- `room thread interactions grant`
- `room thread interactions answer`
- `room thread interactions respond`
- `room thread interactions deny`

## environment

- `room environment`
- `room environment providers`
- `room environment list`
- `room environment delete`
- `room environment show`
- `room environment status`
- `room environment branches`
- `room environment paths`
- `room environment diff`
- `room environment diff-files`
- `room environment diff-file`
- `room environment diff-patch`
- `room environment update`
- `room environment commit`
- `room environment archive-threads`
- `room environment pull-request`
- `room environment pull-request show`
- `room environment pull-request ready`
- `room environment pull-request draft`
- `room environment pull-request merge`

## file

- `room file`
- `room file read`
- `room file write`
- `room file list`
- `room file paths`
- `room file mkdir`
- `room file move`
- `room file remove`

## theme

- `room theme`
- `room theme list`
- `room theme set`
- `room theme dir`
- `room theme favicon`
- `room theme favicon set`
- `room theme favicon reset`
- `room theme show`
- `room theme reset`

## plugin

- `room plugin`
- `room plugin search`
- `room plugin list`
- `room plugin source`
- `room plugin install`
- `room plugin outdated`
- `room plugin update`
- `room plugin new`
- `room plugin types`
- `room plugin migrate`
- `room plugin build`
- `room plugin dev`
- `room plugin reload`
- `room plugin rpc`
- `room plugin rpc list`
- `room plugin rpc inspect`
- `room plugin rpc call`
- `room plugin enable`
- `room plugin disable`
- `room plugin config`
- `room plugin token`
- `room plugin run`
- `room plugin logs`
- `room plugin remove`

## marketplace

- `room marketplace`
- `room marketplace add`
- `room marketplace list`
- `room marketplace refresh`
- `room marketplace remove`

## skill

- `room skill`
- `room skill list`
- `room skill show`
- `room skill files`
- `room skill update`
- `room skill delete`
- `room skill search`
- `room skill registry`
- `room skill registry detail`
- `room skill install`
- `room skill cli-skills-status`
- `room skill install-cli-skills`

## guide

- `room guide`

## voice

- `room voice`
- `room voice transcribe`

## browser

- `room browser`
- `room browser instances`
- `room browser tabs`
- `room browser create`
- `room browser acquire`
- `room browser connection`
- `room browser release`
- `room browser reveal`
- `room browser close`
- `room browser capture`
- `room browser watch`
- `room browser import-sources`
- `room browser import-cookies`

Machine lists and name/ID selectors include machines still being created. Machine creation is durable: `create --no-wait` returns the creating host ID. `machine show <host-id>` reads progress and `machine remove <host-id>` cancels it. SIGINT only stops following.

Machine environment: `room machine env list`, `room machine env set NAME`
(value from stdin), and `room machine env unset NAME`; all accept `--json`.

Standalone `room machine create` machines remain until explicitly removed.
