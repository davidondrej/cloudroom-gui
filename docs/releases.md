# GUI source releases

## 2026-09-22 developer alpha

Source update only. This release does not include a new macOS installer or update an installed app.

### Changes

- Codex/Pi Local-to-Cloud Teleport with preserved history, queued messages, attachments, and recovery.
- Guided cloud Codex and Cursor login, cloud Claude Code support, and clearer reconnect/storage notices.
- Localhost cloud previews, default-on Command Guard, and safer desktop installation helpers.
- Consistent Room branding, improved search, per-provider Fast mode, queues, and mobile voice feedback.

### Compatibility and limits

- Building is account-free. The GUI currently requires an invite-enabled Cloudroom account, even for local work. Manual self-hosted core configuration does not bypass that gate. The core remains independently usable without the GUI.
- New cloud sessions require `direct_workspaces` and, with the default safety setting, `command_guard` in `GET /v1/capabilities`. Use public core [`source-2026-09-23`](https://github.com/davidondrej/cloudroom-core/releases/tag/source-2026-09-23) or newer. Do not disable the guard merely to bypass this requirement.
- Teleport, previews, and guided login require their corresponding core capabilities. Update GUI and host daemon together; unsupported operations fail rather than fall back to Local.
- Cursor remains experimental. Its ACP transport does not enforce Command Guard, so guarded starts are rejected. An intermittent shutdown timeout remains under investigation.
- This source release is not fresh installed-app or laptop-sleep acceptance. No desktop-launching tests were run for publication.

### Verification

Standalone builds/typechecks, app lint, configuration/scripts suites, focused UI/backend tests, and the non-launching menu tests passed. The public diff passed the secret scan. Bundled core client and Python helpers match their canonical copies.

### Maintainer follow-up

The provider-literal baseline records the reviewed Cloudroom integrations by file, count, owner, and removal condition. Replace explicit harness checks with capability contracts as those contracts become available. The scanner and its regression assertions remain enabled; this is not a blanket exemption for Cloudroom code.
