import type { BbPluginApi, PluginCliResult } from "@get-bb/plugin-sdk";
import {
  mobilePairingPayload,
  type MobilePairingPayload,
} from "@cloudroom/connect-client";
import type { ShareHostResolver } from "./hosts.js";
import { MachineCodeError } from "./machine-code.js";
import type { MobilePairingGate } from "./rpc.js";
import { parseSharePort } from "./shares.js";
import type { ConnectTunnel } from "./tunnel.js";
import type { PhoneRelay } from "./phone.js";
import type { ConnectStatus } from "./types.js";

interface ParsedFlags {
  flags: Map<string, string | true>;
}

function parseFlags(argv: string[]): ParsedFlags {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument "${arg}".\n\n${helpText()}`);
    }
    const [rawName, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
    if (!rawName) throw new Error(`Invalid flag ${arg}`);
    if (inlineValue !== undefined) {
      flags.set(rawName, inlineValue);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(rawName, next);
      index += 1;
    } else {
      flags.set(rawName, true);
    }
  }
  return { flags };
}

function stringFlag(parsed: ParsedFlags, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return value === undefined || value === true ? undefined : value;
}

function validateFlags(
  parsed: ParsedFlags,
  options: { boolean?: readonly string[]; value?: readonly string[] },
): void {
  const booleans = new Set(options.boolean ?? []);
  const values = new Set(options.value ?? []);
  for (const [name, value] of parsed.flags) {
    if (!booleans.has(name) && !values.has(name)) {
      throw new Error(`Unknown flag --${name}`);
    }
    if (booleans.has(name) && value !== true) {
      throw new Error(`--${name} does not take a value`);
    }
    if (values.has(name) && value === true) {
      throw new Error(`--${name} requires a value`);
    }
  }
}

function helpText(): string {
  return [
    "Cloudroom Connect opens this Cloudroom from your phone at https://<id>.cloudroom.run.",
    "It sets itself up once you are signed in to Cloudroom. Share HTTP ports from any enrolled host.",
    "",
    "  room-cli connect status              Show remote-access status",
    "  room-cli connect phone-code          Get a one-time code for cloudroom.dev/mobile",
    "  room-cli connect sign-out-phones     Sign out every phone and browser",
    "  room-cli connect expose <port> [--host <name-or-id>]    Share a port from the thread's host",
    "  room-cli connect unexpose <port> [--host <name-or-id>]  Stop sharing a port on that host",
    "  room-cli connect shares [--host <name-or-id>]           List shares for the thread's host",
    "  room-cli connect off                 Forget the old getbb.app pairing",
    "  room-cli connect servers             List servers on the old getbb.app account",
    "  room-cli connect machine-code        Legacy native-device enrollment (not used by the PWA)",
    "",
    "On your phone, open cloudroom.dev/mobile and enter the code, then add it to your home screen.",
  ].join("\n");
}

function formatStatus(status: ConnectStatus): string {
  const lines = !status.paired
    ? [
        status.signedIn
          ? `Setting up${status.lastError ? ` (${status.lastError})` : ""}`
          : "Sign in to Cloudroom to use it on your phone.",
      ]
    : [`${status.url}  ${status.state}`];
  if (status.paired && status.lastError !== null && status.state !== "connected") {
    lines.push(`  last error: ${status.lastError}`);
  }
  if (status.legacy !== null) {
    lines.push(`  old getbb.app link: ${status.legacy.url}  ${status.legacy.state}`);
  }
  if (status.shares.length > 0) {
    lines.push("  shares:");
    for (const share of status.shares) {
      lines.push(
        `    ${share.hostName} (${share.hostId})  ${share.port}  ${share.url || `unavailable: ${share.unavailableReason ?? "unknown reason"}`}`,
      );
    }
  }
  return lines.join("\n");
}

function asJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function notPairedError(): string {
  return "Cloudroom Connect is not set up yet — sign in to Cloudroom, then try again";
}

function machineCodeErrorText(
  error: MachineCodeError,
  dashboardUrl: string,
): string {
  switch (error.code) {
    case "not_paired":
      return "no old getbb.app pairing on this Mac";
    case "machine_limit":
      return `this account has reached its connect machine limit — revoke a device you no longer use at ${dashboardUrl}, then try again`;
    case "network":
      return "could not reach the connect service to mint a machine code — check the connection and try again";
  }
}

function mobilePairingDisabledError(): string {
  return "Legacy native-device pairing is off. The Cloudroom PWA uses your browser login, not a pairing code. For an existing native BB client, enable pairing with `room-cli settings experiment mobileApp true`.";
}

function formatMachineCode(payload: MobilePairingPayload): string {
  const minutes = Math.max(
    0,
    Math.round((payload.expiresAt - Date.now()) / 60_000),
  );
  return [
    `Code:       ${payload.code}`,
    `Server:     ${payload.serverUrl}`,
    `Apex:       ${payload.apex}`,
    `Expires:    ${new Date(payload.expiresAt).toISOString()} (in about ${minutes} min)`,
    "",
    "Enter this code in your existing native BB client, not the Cloudroom PWA. The device",
    "enrolls as a connect machine on this account — it appears in the getbb.app",
    "dashboard's machine list, where you can revoke it. The code works once.",
  ].join("\n");
}

export function registerConnectCli(args: {
  bb: Pick<BbPluginApi, "cli">;
  relay: ConnectTunnel;
  legacy: ConnectTunnel;
  phone: PhoneRelay;
  status: () => ConnectStatus;
  hostResolver: ShareHostResolver;
  mobilePairing: MobilePairingGate;
}): void {
  const { bb, relay, legacy, phone, status, hostResolver, mobilePairing } = args;
  const tunnel = relay;
  bb.cli.register({
    name: "connect",
    summary:
      "Open this Cloudroom from your phone at cloudroom.run and share ports",
    commands: [
      {
        name: "status",
        summary: "Show remote-access status",
        usage: "room-cli connect status [--json]",
      },
      {
        name: "phone-code",
        summary: "Get a one-time code for cloudroom.dev/mobile",
        usage: "room-cli connect phone-code [--json]",
      },
      {
        name: "sign-out-phones",
        summary: "Sign out every phone and browser",
        usage: "room-cli connect sign-out-phones [--json]",
      },
      {
        name: "off",
        summary: "Forget the old getbb.app pairing",
        usage: "room-cli connect off [--json]",
      },
      {
        name: "expose",
        summary: "Share an HTTP port from an enrolled host",
        usage: "room-cli connect expose <port> [--host <name-or-id>] [--json]",
      },
      {
        name: "unexpose",
        summary: "Stop sharing an HTTP port from a host",
        usage:
          "room-cli connect unexpose <port> [--host <name-or-id>] [--json]",
      },
      {
        name: "shares",
        summary: "List shared ports and their public URLs",
        usage: "room-cli connect shares [--host <name-or-id>] [--json]",
      },
      {
        name: "servers",
        summary: "List servers on the old getbb.app account",
        usage: "room-cli connect servers [--json]",
      },
      {
        name: "machine-code",
        summary:
          "Legacy native-device enrollment; not used by the Cloudroom PWA",
        usage: "room-cli connect machine-code [--json]",
      },
    ],
    async run(argv, ctx): Promise<PluginCliResult> {
      try {
        const [first] = argv;
        if (first === "status") {
          const parsed = parseFlags(argv.slice(1));
          validateFlags(parsed, { boolean: ["json"] });
          const current = { ...status(), shares: await relay.listShares() };
          return {
            exitCode: 0,
            stdout: parsed.flags.has("json")
              ? asJson(current)
              : `${formatStatus(current)}\n`,
          };
        }
        if (first === "phone-code") {
          const parsed = parseFlags(argv.slice(1));
          validateFlags(parsed, { boolean: ["json"] });
          const code = await phone.phoneCode();
          return {
            exitCode: 0,
            stdout: parsed.flags.has("json")
              ? asJson(code)
              : `Code: ${code.code}\nOn your phone, open cloudroom.dev/mobile and enter it, or open ${code.url}\nIt works once, for 10 minutes.\n`,
          };
        }
        if (first === "sign-out-phones") {
          const parsed = parseFlags(argv.slice(1));
          validateFlags(parsed, { boolean: ["json"] });
          const result = await phone.signOutPhones();
          return {
            exitCode: 0,
            stdout: parsed.flags.has("json")
              ? asJson(result)
              : `Signed out ${result.revoked} phone or browser session(s)\n`,
          };
        }
        if (first === "off") {
          const parsed = parseFlags(argv.slice(1));
          validateFlags(parsed, { boolean: ["json"] });
          await legacy.disconnect();
          return {
            exitCode: 0,
            stdout: parsed.flags.has("json")
              ? asJson(status())
              : "Forgot the old getbb.app pairing\n",
          };
        }
        if (first === "expose") {
          const portArg = argv[1];
          if (portArg === undefined || portArg.startsWith("--")) {
            return {
              exitCode: 1,
              stderr:
                "Usage: room-cli connect expose <port> [--host <name-or-id>] [--json]\n",
            };
          }
          const parsed = parseFlags(argv.slice(2));
          validateFlags(parsed, { boolean: ["json"], value: ["host"] });
          if (!relay.status().paired && !legacy.status().paired) {
            return { exitCode: 1, stderr: `${notPairedError()}\n` };
          }
          const targetHost = await hostResolver.resolve(
            ctx,
            stringFlag(parsed, "host"),
          );
          const listing = await tunnel.expose(
            parseSharePort(portArg),
            targetHost,
          );
          if (parsed.flags.has("json")) {
            return { exitCode: 0, stdout: asJson(listing) };
          }
          return {
            exitCode: 0,
            stdout: `${listing.url}\n`,
          };
        }
        if (first === "unexpose") {
          const portArg = argv[1];
          if (portArg === undefined || portArg.startsWith("--")) {
            return {
              exitCode: 1,
              stderr:
                "Usage: room-cli connect unexpose <port> [--host <name-or-id>] [--json]\n",
            };
          }
          const parsed = parseFlags(argv.slice(2));
          validateFlags(parsed, { boolean: ["json"], value: ["host"] });
          const targetHost =
            stringFlag(parsed, "host") ?? (await hostResolver.resolveId(ctx));
          const result = await tunnel.unexpose(
            parseSharePort(portArg),
            targetHost,
          );
          if (parsed.flags.has("json")) {
            return { exitCode: 0, stdout: asJson(result) };
          }
          if (!result.removed) {
            return {
              exitCode: 0,
              stdout: `Port ${result.port} was not shared on ${result.hostName} (${result.hostId}) (idempotent).\n`,
            };
          }
          return {
            exitCode: 0,
            stdout: `Stopped sharing port ${result.port} on ${result.hostName} (${result.hostId})\n`,
          };
        }
        if (first === "shares") {
          const parsed = parseFlags(argv.slice(1));
          validateFlags(parsed, { boolean: ["json"], value: ["host"] });
          const targetHost = await hostResolver.resolve(
            ctx,
            stringFlag(parsed, "host"),
          );
          const shares = await tunnel.listShares(targetHost.id);
          if (parsed.flags.has("json")) {
            return {
              exitCode: 0,
              stdout: asJson({ host: targetHost, shares }),
            };
          }
          if (shares.length === 0) {
            return { exitCode: 0, stdout: "No shared ports\n" };
          }
          const lines = shares.map(
            (share) =>
              `${share.hostName} (${share.hostId})  ${share.port}  ${share.url || `unavailable: ${share.unavailableReason ?? "unknown reason"}`}`,
          );
          return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
        }
        if (first === "servers") {
          const parsed = parseFlags(argv.slice(1));
          validateFlags(parsed, { boolean: ["json"] });
          if (!legacy.status().paired) {
            return { exitCode: 1, stderr: "no old getbb.app pairing on this Mac\n" };
          }
          const result = await legacy.listAccountServers();
          if (parsed.flags.has("json")) {
            return { exitCode: 0, stdout: asJson(result) };
          }
          if (result.servers.length === 0) {
            return { exitCode: 0, stdout: "No servers on this account\n" };
          }
          const handleWidth = Math.max(
            "HANDLE".length,
            ...result.servers.map((s) => s.handle.length),
          );
          const nameWidth = Math.max(
            "NAME".length,
            ...result.servers.map((s) => s.name.length),
          );
          const urlWidth = Math.max(
            "URL".length,
            ...result.servers.map((s) => s.url.length),
          );
          const lines = [
            `${"HANDLE".padEnd(handleWidth)}  ${"NAME".padEnd(nameWidth)}  ${"URL".padEnd(urlWidth)}  LIVE  SELF`,
            ...result.servers.map((s) => {
              const live = s.live ? "yes" : "no";
              const self = s.handle === result.selfHandle ? "*" : "";
              return `${s.handle.padEnd(handleWidth)}  ${s.name.padEnd(nameWidth)}  ${s.url.padEnd(urlWidth)}  ${live.padEnd(4)}  ${self}`;
            }),
          ];
          return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
        }
        if (first === "machine-code") {
          const parsed = parseFlags(argv.slice(1));
          validateFlags(parsed, { boolean: ["json"] });
          if (!(await mobilePairing.enabled())) {
            return {
              exitCode: 1,
              stderr: `${mobilePairingDisabledError()}\n`,
            };
          }
          let payload: MobilePairingPayload;
          try {
            payload = mobilePairingPayload(await legacy.createMachineCode());
          } catch (error) {
            if (error instanceof MachineCodeError) {
              return {
                exitCode: 1,
                stderr: `${machineCodeErrorText(error, legacy.status().dashboardUrl)}\n`,
              };
            }
            throw error;
          }
          if (parsed.flags.has("json")) {
            return { exitCode: 0, stdout: asJson(payload) };
          }
          return { exitCode: 0, stdout: `${formatMachineCode(payload)}\n` };
        }
        if (first !== undefined && !first.startsWith("--")) {
          return {
            exitCode: 1,
            stderr: `Unknown connect command '${first}'.\n\n${helpText()}\n`,
          };
        }
        const parsed = parseFlags(argv);
        validateFlags(parsed, {
          boolean: ["json"],
          value: ["code", "server", "base-url"],
        });
        const code = stringFlag(parsed, "code");
        if (code === undefined) {
          return { exitCode: 0, stdout: `${helpText()}\n` };
        }
        const server = stringFlag(parsed, "server");
        const baseUrl = stringFlag(parsed, "base-url");
        const paired = await legacy.pair({
          code,
          ...(server !== undefined ? { serverUrl: server } : {}),
          ...(baseUrl !== undefined ? { baseUrl } : {}),
        });
        if (parsed.flags.has("json")) {
          return { exitCode: 0, stdout: asJson(paired) };
        }
        return {
          exitCode: 0,
          stdout: `Paired the old getbb.app link as ${paired.handle} — reachable at ${paired.url}\n`,
        };
      } catch (error) {
        return {
          exitCode: 1,
          stderr: `${error instanceof Error ? error.message : String(error)}\n`,
        };
      }
    },
  });
}
