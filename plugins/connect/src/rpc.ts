import { z } from "zod";
import { defineRpcContract, type PluginRpcHandlers } from "@get-bb/plugin-sdk";
import {
  ConnectListError,
  type DesktopSession,
  type ListAccountServersResult,
} from "@cloudroom/connect-client";
import { ConnectPairError } from "./redeem.js";
import type { ConnectTunnel } from "./tunnel.js";
import type { PhoneRelay } from "./phone.js";
import type { ConnectStatus, PhoneCode, ShareListing } from "./types.js";
import { MachineCodeError, type MachineCode } from "./machine-code.js";
import type { ShareHostResolver } from "./hosts.js";

const pairInputSchema = z.object({
  code: z.string().min(1),
  server: z.string().url().optional(),
  baseUrl: z.string().url().optional(),
});

const portInputSchema = z
  .object({
    port: z.number().int().min(1).max(65535),
    hostId: z.string().min(1).optional(),
  })
  .strict();
const revokeMachineInputSchema = z.object({ machineId: z.string().min(1) });

const shareListingSchema: z.ZodType<ShareListing> = z
  .object({
    hostId: z.string(),
    hostName: z.string(),
    port: z.number().int(),
    createdAt: z.number(),
    url: z.string(),
    unavailableReason: z.string().optional(),
  })
  .strict();

const stateSchema = z.enum(["disconnected", "pairing", "connected", "reconnecting"]);

const connectStatusSchema: z.ZodType<ConnectStatus> = z
  .object({
    state: stateSchema,
    paired: z.boolean(),
    handle: z.string().nullable(),
    url: z.string().nullable(),
    dashboardUrl: z.string(),
    lastError: z.string().nullable(),
    nextRetryAt: z.number().nullable(),
    since: z.number(),
    remoteClients: z.number().int(),
    lastRemoteActivityAt: z.number().nullable(),
    shares: z.array(shareListingSchema),
    signedIn: z.boolean(),
    legacy: z.object({ url: z.string(), state: stateSchema }).strict().nullable(),
  })
  .strict();

const phoneCodeSchema: z.ZodType<PhoneCode> = z
  .object({ code: z.string(), expiresAt: z.number(), url: z.string() })
  .strict();

const listAccountServersResultSchema: z.ZodType<ListAccountServersResult> = z
  .object({
    servers: z.array(
      z
        .object({
          handle: z.string(),
          name: z.string(),
          live: z.boolean(),
          url: z.string(),
        })
        .strict(),
    ),
    selfHandle: z.string(),
  })
  .strict();

const desktopSessionSchema: z.ZodType<DesktopSession> = z
  .object({
    cookie: z
      .object({
        domain: z.string(),
        expiresAt: z.number().int(),
        name: z.string(),
        value: z.string(),
      })
      .strict(),
  })
  .strict();

const mobilePairingSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

const machineCodeSchema: z.ZodType<MachineCode> = z
  .object({
    code: z.string(),
    expiresAt: z.number(),
    serverUrl: z.string(),
  })
  .strict();

export const connectRpcContract = defineRpcContract({
  pair: { input: pairInputSchema, output: connectStatusSchema },
  status: { input: z.null(), output: connectStatusSchema },
  disconnect: { input: z.null(), output: connectStatusSchema },
  phoneCode: { input: z.null(), output: phoneCodeSchema },
  signOutPhones: {
    input: z.null(),
    output: z.object({ revoked: z.number().int() }).strict(),
  },
  expose: { input: portInputSchema, output: shareListingSchema },
  unexpose: {
    input: portInputSchema,
    output: z
      .object({
        removed: z.boolean(),
        hostId: z.string(),
        hostName: z.string(),
        port: z.number().int(),
      })
      .strict(),
  },
  listShares: { input: z.null(), output: z.array(shareListingSchema) },
  listAccountServers: {
    input: z.null(),
    output: listAccountServersResultSchema,
  },
  createDesktopSession: { input: z.null(), output: desktopSessionSchema },
  mobilePairing: { input: z.null(), output: mobilePairingSchema },
  createMachineCode: { input: z.null(), output: machineCodeSchema },
  revokeMachine: {
    input: revokeMachineInputSchema,
    output: z.object({ ok: z.literal(true) }).strict(),
  },
});

type ConnectRpcHandlers = PluginRpcHandlers<typeof connectRpcContract>;

async function rethrowErrorCode<T>(
  operation: () => Promise<T>,
  isCoded: (error: unknown) => error is { code: string },
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isCoded(error)) throw new Error(error.code);
    throw error;
  }
}

export interface MobilePairingGate {
  enabled(): Promise<boolean>;
}

export function createRpcHandlers(args: {
  relay: ConnectTunnel;
  legacy: ConnectTunnel;
  phone: PhoneRelay;
  status: () => ConnectStatus;
  hostResolver: ShareHostResolver;
  mobilePairing: MobilePairingGate;
}): ConnectRpcHandlers {
  const { relay, legacy, phone, status, hostResolver, mobilePairing } = args;
  const tunnel = relay;
  return {
    async pair(args) {
      await rethrowErrorCode(
        () =>
          legacy.pair({
            code: args.code,
            ...(args.server !== undefined ? { serverUrl: args.server } : {}),
            ...(args.baseUrl !== undefined ? { baseUrl: args.baseUrl } : {}),
          }),
        (error) => error instanceof ConnectPairError,
      );
      return status();
    },
    async status() {
      return { ...status(), shares: await relay.listShares() };
    },
    async disconnect() {
      await legacy.disconnect();
      return status();
    },
    async phoneCode() {
      return phone.phoneCode();
    },
    async signOutPhones() {
      return phone.signOutPhones();
    },
    async expose(args) {
      const host =
        args.hostId === undefined
          ? await hostResolver.serverHost()
          : await hostResolver.byId(args.hostId);
      return tunnel.expose(args.port, host);
    },
    async unexpose(args) {
      return tunnel.unexpose(
        args.port,
        args.hostId ?? (await hostResolver.serverHostId()),
      );
    },
    async listShares() {
      return tunnel.listShares();
    },
    async listAccountServers() {
      return rethrowErrorCode(
        () => legacy.listAccountServers(),
        (error) => error instanceof ConnectListError,
      );
    },
    async createDesktopSession() {
      return rethrowErrorCode(
        () => legacy.createDesktopSession(),
        (error) => error instanceof ConnectListError,
      );
    },
    async mobilePairing() {
      return { enabled: await mobilePairing.enabled() };
    },
    async createMachineCode() {
      return rethrowErrorCode(
        () => legacy.createMachineCode(),
        (error) => error instanceof MachineCodeError,
      );
    },
    async revokeMachine(args) {
      await legacy.revokeMachine(args.machineId);
      return { ok: true };
    },
  };
}
