const CLI_PATH =
  "/Applications/Cloudroom.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/cloudroom";
const RELEASES_URL = "https://github.com/davidondrej/cloudroom-gui/releases";

const said = (text?: string | null) =>
  text?.trim() ? `: "${text.trim().replace(/\s+/g, " ").slice(0, 400)}".` : ".";

const fixPrompt = (problem: string, look: string) =>
  `${problem} ${look} Find the root cause and fix it without losing any work, then tell me what was wrong. If \`cloudroom\` is not on your PATH, use ${CLI_PATH}.`;

export const cloudThreadFixPrompt = (threadId: string, agent: string, error?: string | null) =>
  fixPrompt(
    `My Cloudroom Cloud thread ${threadId} (${agent}) failed${said(error)}`,
    `Investigate with \`cloudroom thread show ${threadId}\` and \`cloudroom vm run '<command>'\` on my cloud VM.`,
  );

export const cloudLoginFixPrompt = (threadId: string, agent: string) =>
  fixPrompt(
    `My Cloudroom Cloud thread ${threadId} needs ${agent} signed in on my cloud VM.`,
    "Check it with `cloudroom cloud status --json` and `cloudroom vm run '<command>'`, then help me sign in there without pasting tokens into chat.",
  );

export const syncFixPrompt = (state: string, issue?: string | null) =>
  fixPrompt(
    `Cloudroom's automatic sync between this computer and my cloud VM is not working (state: ${state})${said(issue)}`,
    "Check `cloudroom cloud status --json`, ~/.gui-cloudroom/cloudroom-sync/, and the logs in ~/.gui-cloudroom/logs/.",
  );

export const projectFilesFixPrompt = (threadId: string, error?: string | null) =>
  fixPrompt(
    `Cloudroom could not move my work to the cloud for thread ${threadId}${said(error)}`,
    `Check \`cloudroom thread show ${threadId}\` and \`cloudroom cloud thread-workspace ${threadId}\`, then copy any missing project files with \`cloudroom vm push\`.`,
  );

export const cloudUnavailableFixPrompt = (error?: string | null) =>
  fixPrompt(
    `My Cloudroom desktop app cannot reach my cloud VM${said(error)}`,
    "Check `cloudroom cloud status --json`, then run `cloudroom vm run 'systemctl status cloudroom --no-pager; df -h'` if the VM answers.",
  );

export const crashFixPrompt = (error: string) =>
  fixPrompt(
    `The Cloudroom desktop app crashed${said(error)}`,
    "Check the logs in ~/.gui-cloudroom/logs/ and `cloudroom status --json`.",
  );

export const appUpdateFixPrompt = (current: string, latest: string | null) =>
  `Update my Cloudroom desktop app from version ${current} to ${latest ?? "the newest version"}. Download the newest release for this computer from ${RELEASES_URL}, quit Cloudroom, replace the old app (on macOS: /Applications/Cloudroom.app), and reopen it. Do not delete ~/.gui-cloudroom; it holds my data. Confirm the new version when you are done.`;
