/**
 * WebSocket presence helpers.
 *
 * Earlier `onConnect` / `onClose` / `broadcastPresence` mixed WS-state
 * munging (reading upgrade headers, stamping connection state) with
 * structured logging. ~100 LOC inside the agent class with three sites
 * that had to stay coordinated. The pure piece (`buildPresencePayload`)
 * couldn't be unit-tested because it lived inside the class.
 *
 * This module splits the concerns:
 *
 *   - `attachConnection` — read upgrade headers, set state, log connect
 *   - `detachConnection` — log close with the right turn snapshot
 *   - `buildPresencePayload` — pure: derive the broadcast payload
 *   - `currentUserIdFromConnection` — read userId off connection state
 *
 * The agent's hooks become 1-3 line delegations.
 */
import { logEvent } from "@data-agent/shared";
import type { Connection, ConnectionContext } from "agents";
import type { TurnState } from "./turn-state";

/** Public shape of a connection's per-WS state. Set by `attachConnection`. */
export interface PresenceState {
  userId: string;
  tenantId?: string;
  joinedAt: number;
}

export interface AttachOpts {
  chatId: string;
  /** Live connection count after the attach (so we can include it in
   *  the structured log). */
  activeConnections: number;
}

/**
 * Stamp presence state onto a freshly-opened connection and emit
 * `chat.ws.connect`. The headers are populated by `onBeforeConnect` in
 * `index.ts` from the verified chat-token JWT.
 */
export function attachConnection(
  connection: Connection,
  ctx: ConnectionContext,
  opts: AttachOpts
): void {
  const userId = ctx.request.headers.get("x-data-agent-user-id") ?? "anonymous";
  const tenantId = ctx.request.headers.get("x-data-agent-tenant-id") ?? "";
  connection.setState({ userId, tenantId, joinedAt: Date.now() } as never);

  logEvent({
    event: "chat.ws.connect",
    chatId: opts.chatId,
    userId,
    tenantId,
    connectionId: connection.id,
    activeConnections: opts.activeConnections,
  });
}

export interface DetachOpts {
  chatId: string;
  code: number;
  reason: string;
  wasClean: boolean;
  /** Snapshot of the in-flight turn state — captures activeTurnId +
   *  msSinceLastChunk for "did this close abort a turn" diagnosis. */
  turn: TurnState;
  /** Connections remaining AFTER this close. */
  remainingConnections: number;
}

/**
 * Emit `chat.ws.close`. Single most useful event when diagnosing a
 * mid-turn abort:
 *
 *   1000 normal closure
 *   1001 going away (browser tab/page closed) — common
 *   1006 abnormal — connection lost, no close frame (network flap,
 *        tab crash). What we saw on chat 62605d6f.
 *   1011 server error
 *   1012 service restart
 *   4xxx application-defined (Think uses 1000/1001 mostly)
 *
 * Called BEFORE `super.onClose` so the in-flight turn id is still
 * bound when we log it.
 */
export function detachConnection(connection: Connection, opts: DetachOpts): void {
  const state = connection.state as PresenceState | null | undefined;
  const sessionMs = state?.joinedAt && state.joinedAt > 0 ? Date.now() - state.joinedAt : null;
  const snap = opts.turn.snapshot();

  logEvent({
    event: "chat.ws.close",
    level: opts.wasClean ? "info" : "warn",
    chatId: opts.chatId,
    userId: state?.userId ?? null,
    tenantId: state?.tenantId ?? null,
    connectionId: connection.id,
    code: opts.code,
    reason: opts.reason ? opts.reason.slice(0, 200) : "",
    wasClean: opts.wasClean,
    sessionMs,
    activeTurnId: snap.turnId,
    msSinceLastChunk: snap.msSinceLastChunk,
    remainingConnections: opts.remainingConnections,
  });
}

/**
 * Pure: derive the JSON payload broadcast as `data_agent_presence`.
 * Dedupes by userId, keeps the earliest `joinedAt` so a user opening
 * two tabs doesn't flicker as "just joined" each time.
 *
 * Returns the wire-ready JSON string so the caller can pass it
 * straight to `agent.broadcast(...)`.
 */
export function buildPresencePayload(
  connections: Iterable<{ state: PresenceState | null | undefined }>
): string {
  const seen = new Map<string, { userId: string; joinedAt: number }>();
  for (const conn of connections) {
    const state = conn.state;
    if (!state) continue;
    const existing = seen.get(state.userId);
    if (!existing || existing.joinedAt > state.joinedAt) {
      seen.set(state.userId, { userId: state.userId, joinedAt: state.joinedAt });
    }
  }
  return JSON.stringify({
    type: "data_agent_presence",
    users: [...seen.values()].toSorted((a, b) => a.joinedAt - b.joinedAt),
  });
}

/** Read `userId` off a connection's presence state. */
export function currentUserIdFromConnection(connection: Connection): string | undefined {
  return (connection.state as PresenceState | null | undefined)?.userId;
}
