/**
 * Bound logger + audit envelope for in-turn events.
 *
 * Every chat-agent log/audit call repeats the same envelope:
 *   chatId, tenantId, userId, turnId, (sometimes) connections.
 *
 * Earlier this was hand-written at 7+ different call sites in
 * agent.ts. A missed field meant a turn was unfilterable in
 * Workers Logs; correlating an audit row to a turn required
 * rebuilding the join in your head.
 *
 * `TurnLogger` carries the envelope; you only pass the
 * event-specific fields. The agent constructs one per-instance
 * and lets it read tenant/user/turn id off live state via
 * lazy getters — so a single instance works across many turns.
 */
import { logEvent, type AuditEvent } from "@data-agent/shared";
import { auditFromAgent } from "./audit";
import type { Env } from "./env";

export interface LogEnvelope {
  chatId: string;
  tenantId: string | null;
  userId: string | null;
  turnId: string | null;
}

/** Source of truth for the bound fields. Implemented by the agent. */
export interface EnvelopeProvider {
  readonly chatId: string;
  readonly tenantId: string | null;
  readonly userId: string | null;
  readonly turnId: string | null;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface EventFields {
  level?: LogLevel;
  [key: string]: unknown;
}

export class TurnLogger {
  constructor(
    private readonly env: Env,
    private readonly provider: EnvelopeProvider,
    /** Hook so the agent can fold in `connections: countConnections(this)`
     *  without each call site reconstructing it. */
    private readonly extras: () => Record<string, unknown> = () => ({})
  ) {}

  /** Emit a structured log event with the bound envelope merged in. */
  event(event: string, fields: EventFields = {}): void {
    const { level, ...rest } = fields;
    logEvent({
      event,
      ...(level ? { level } : {}),
      chatId: this.provider.chatId,
      tenantId: this.provider.tenantId,
      userId: this.provider.userId,
      turnId: this.provider.turnId,
      ...this.extras(),
      ...rest,
    });
  }

  /**
   * Best-effort audit insert. Skips when there's no tenant (un-
   * resolvable chats; the LLM call itself will fail on those, the
   * audit gap is the least of the user's worries).
   *
   * Returns the underlying promise so the caller can pass it to
   * `ctx.waitUntil` — preserving the "don't block the turn" property.
   */
  audit(
    action: string,
    target: string | null,
    payload: Record<string, unknown> | null,
    /** Optional override; almost always you want the bound user. */
    userOverride?: string | null
  ): Promise<void> | null {
    const tenantId = this.provider.tenantId;
    if (!tenantId) return null;
    const event: AuditEvent = {
      tenantId,
      chatId: this.provider.chatId,
      userId: userOverride === undefined ? this.provider.userId : userOverride,
      action,
      target: target ?? undefined,
      payload,
    };
    return auditFromAgent(this.env, event);
  }
}
