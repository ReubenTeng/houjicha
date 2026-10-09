import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Orchestration } from "../orchestration/application.js";
import { DomainError, type ActorContext } from "../orchestration/contract.js";
import type { Config } from "../reap/config.js";
import type { Database } from "../reap/db.js";
import type { Identity } from "../reap/domain.js";
import { AppError, asAppError, log } from "../reap/errors.js";
import type { Envelope } from "../reap/schemas.js";
import { groupInputSchema, groupOutputSchema, groupResultSchemas, groupScopes, type GroupInput } from "./schemas.js";

export interface GroupBackend {
  app: Pick<Orchestration, "searchCatalog" | "findGroupBuys" | "getGroupBuy" | "execute" | "getMyUpdates" | "getPaymentStatus">;
  capabilities: { catalog: boolean; payments: boolean; consent: boolean };
}

export class GroupBuyTool {
  constructor(private readonly config: Pick<Config, "mode">, private readonly db: Pick<Database, "actor" | "rateLimit" | "audit">, private readonly backend?: GroupBackend) {}

  async call(raw: unknown, identity: Identity): Promise<Envelope> {
    let userId: string | null = null;
    let result: Envelope;
    try {
      const input = groupInputSchema.parse(raw);
      const missing = groupScopes(input).find(scope => !identity.scopes.includes(scope));
      if (missing) throw new AppError("FORBIDDEN", `This group action requires ${missing}. Reconnect with the required permission.`);
      userId = (await this.db.actor(identity)).id;
      await this.db.rateLimit(userId);
      if (!this.backend) throw new AppError("GROUP_BACKEND_UNAVAILABLE", "Configure the sandbox group-buy database and catalog. Group-buy payments and trusted consent are separate integrations; no demo fallback is used.");
      const { capabilities } = this.backend;
      if (["create_group_buy", "join_group_buy"].includes(input.action) && !capabilities.consent) throw new AppError("GROUP_CONSENT_UNAVAILABLE", "A trusted group-consent backend is not connected. An authorization reference or conversational approval cannot create a grant.");
      if (["find_group_buys", "create_group_buy", "join_group_buy", "leave_group_buy", "close_group_buy", "respond_to_price_change"].includes(input.action) && !capabilities.payments) throw new AppError("GROUP_PAYMENT_UNAVAILABLE", "The collect-first group-payment and verified quote backend is deferred. No group pricing, funding, or checkout was attempted.");
      if (["search_catalog", "find_group_buys", "create_group_buy", "join_group_buy"].includes(input.action) && !capabilities.catalog) throw new AppError("GROUP_CATALOG_UNAVAILABLE", "The group catalog is not configured.");
      const value = await this.dispatch(this.backend.app, { userId }, input);
      const parsed = groupResultSchemas[input.action].safeParse(value);
      if (!parsed.success) throw new AppError("GROUP_CONTRACT_ERROR", "The group backend returned an unexpected result. Read current state before retrying any command.");
      const freshness = input.action === "search_catalog" || input.action === "find_group_buys" ? "INDICATIVE" : groupScopes(input).includes("commerce:prepare") ? "COMMAND_RESULT" : "STORED";
      result = {
        ok: true, mode: this.config.mode, simulated: this.config.mode === "mock", status: "OK",
        data: { action: input.action, result: parsed.data, capabilities: { ...capabilities }, freshness },
        next_action: input.action === "get_payment_status" ? { type: "STORED_STATUS", message: "This is the orchestration snapshot, not a fresh provider verification or proof of payment." } : null,
      };
    } catch (error) {
      const failure = error instanceof DomainError ? new AppError(error.code, `Group action rejected: ${error.code}. Read the current group state before changing the request.`, error.retryable)
        : error instanceof z.ZodError ? new AppError("INVALID_INPUT", "Use the documented group action and its exact fields. Identity and approval assertions are not accepted.")
        : error instanceof AppError ? asAppError(error) : new AppError("GROUP_BACKEND_UNAVAILABLE", "The group backend could not complete the request. Check its connection and schema, then read current state before retrying the same command ID.", true);
      result = { ok: false, mode: this.config.mode, simulated: this.config.mode === "mock", status: failure.code,
        data: error instanceof DomainError && error.currentVersion !== undefined ? { currentVersion: error.currentVersion } : null,
        next_action: { type: failure.code.endsWith("UNAVAILABLE") ? "CONNECT_BACKEND" : "REVIEW_REQUEST", message: failure.message },
        error: { code: failure.code, message: failure.message, retryable: failure.retryable, trace_id: failure.traceId } };
      log("group_tool_error", { code: failure.code, trace_id: failure.traceId });
    }
    if (userId) {
      try { await this.db.audit(userId, "group_buy", result.status, result.error?.trace_id ?? randomUUID()); }
      catch { log("audit_unavailable"); }
    }
    groupOutputSchema.parse(result);
    return result;
  }

  private async dispatch(app: GroupBackend["app"], actor: ActorContext, input: GroupInput): Promise<unknown> {
    switch (input.action) {
      case "search_catalog": return app.searchCatalog(actor, input.query, input.merchantId, input.cursor);
      case "find_group_buys": return app.findGroupBuys(actor, input.merchantId, { lines: input.lines, constraints: input.constraints });
      case "get_group_buy": return app.getGroupBuy(actor, input.groupBuyId);
      case "get_payment_status": return app.getPaymentStatus(actor, input.groupBuyId);
      case "get_my_updates": return app.getMyUpdates(actor, input.cursor, input.limit);
      case "create_group_buy": {
        const { fulfillment, ...create } = input.input;
        return app.execute(actor, { operation: "create", metadata: input.metadata, input: { ...create, ...(fulfillment === undefined ? {} : { fulfillment }) } });
      }
      case "join_group_buy": return app.execute(actor, { operation: "join", metadata: input.metadata, groupBuyId: input.groupBuyId, input: input.input });
      case "respond_to_price_change": return app.execute(actor, { operation: "respond", metadata: input.metadata, groupBuyId: input.groupBuyId, approvalRequestId: input.approvalRequestId, decision: input.decision });
      case "leave_group_buy": return app.execute(actor, { operation: "leave", metadata: input.metadata, groupBuyId: input.groupBuyId });
      case "close_group_buy": return app.execute(actor, { operation: "close", metadata: input.metadata, groupBuyId: input.groupBuyId });
      case "cancel_group_buy": return app.execute(actor, { operation: "cancel", metadata: input.metadata, groupBuyId: input.groupBuyId });
    }
  }
}
