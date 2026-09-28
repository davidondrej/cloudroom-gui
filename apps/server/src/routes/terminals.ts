import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import type { AppDeps } from "../types.js";

export function registerTerminalRoutes(app: Hono, deps: AppDeps): void {
  const { get, patch, post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });
  const routes = publicApiRoutes.terminals;

  // TG3 (HI-1): every mutation and content read on an existing terminal
  // requires the short-lifetime capability issued at creation (and
  // re-issued on authenticated GET). The install capability alone is not
  // sufficient here — that is the owner/target binding.
  const requireTerminalCapability = (
    context: { req: { header(name: string): string | undefined } },
    terminalId: string,
  ): void => {
    deps.terminalSessions.requireTerminalCapability(
      terminalId,
      context.req.header("x-bb-terminal-capability"),
    );
  };

  get(routes.list, (context, query) => {
    const sessions = deps.terminalSessions.listTerminals({ query });
    return context.json({ sessions });
  });

  post(routes.create, async (context, payload) => {
    const session = await deps.terminalSessions.createTerminal({ payload });
    const capability = deps.terminalSessions.issueOrRefreshTerminalCapability(
      session.id,
      session.hostId,
    );
    return context.json({ ...session, capability }, 201);
  });

  get(routes.get, (context) => {
    const terminalId = context.req.param("terminalId");
    const session = deps.terminalSessions.getTerminal({ terminalId });
    // Authenticated re-issue: a client that reloaded (or another surface
    // holding the install capability) obtains the current terminal
    // capability here. The token never reaches a client without it.
    const capability = deps.terminalSessions.issueOrRefreshTerminalCapability(
      terminalId,
      session.hostId,
    );
    return context.json({ ...session, capability });
  });

  patch(routes.update, (context, payload) => {
    const terminalId = context.req.param("terminalId");
    requireTerminalCapability(context, terminalId);
    const session = deps.terminalSessions.renameTerminal({
      payload,
      terminalId,
    });
    return context.json(session);
  });

  post(routes.restart, async (context) => {
    const terminalId = context.req.param("terminalId");
    requireTerminalCapability(context, terminalId);
    const session = await deps.terminalSessions.restartTerminal({
      terminalId,
    });
    return context.json(session, 201);
  });

  post(routes.close, async (context, payload) => {
    const terminalId = context.req.param("terminalId");
    requireTerminalCapability(context, terminalId);
    const session = await deps.terminalSessions.closeTerminal({
      payload,
      terminalId,
    });
    return context.json(session);
  });

  post(routes.input, (context, payload) => {
    const terminalId = context.req.param("terminalId");
    requireTerminalCapability(context, terminalId);
    const session = deps.terminalSessions.sendTerminalInput({
      payload,
      terminalId,
    });
    return context.json(session);
  });

  post(routes.resize, (context, payload) => {
    const terminalId = context.req.param("terminalId");
    requireTerminalCapability(context, terminalId);
    const session = deps.terminalSessions.resizeTerminal({
      payload,
      terminalId,
    });
    return context.json(session);
  });

  get(routes.output, async (context, query) => {
    const terminalId = context.req.param("terminalId");
    requireTerminalCapability(context, terminalId);
    const output = await deps.terminalSessions.readTerminalOutput({
      query,
      terminalId,
    });
    return context.json(output);
  });
}
