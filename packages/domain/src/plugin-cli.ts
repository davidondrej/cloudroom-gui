export const RESERVED_BB_CLI_COMMANDS: readonly string[] = [
  "browser",
  "cloudroom",
  "environment",
  "file",
  "guide",
  "help",
  "machine",
  "manager",
  "marketplace",
  "plugin",
  "project",
  "provider",
  "settings",
  "skill",
  "status",
  "terminal",
  "theme",
  "thread",
  "updates",
  "voice",
];

export function pluginCliCall(pluginId: string, name: string): string {
  if (RESERVED_BB_CLI_COMMANDS.includes(name))
    return `room plugin run ${pluginId}`;
  return `room ${name}`;
}
