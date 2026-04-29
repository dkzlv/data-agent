/**
 * `AgentHost` — unified surface the agent exposes to its collaborators
 * (turn pipeline, debug RPCs, rate-limit driver, title summarizer).
 *
 * Earlier the agent satisfied two separate interfaces:
 *   - `EnvelopeProvider` (turn-logger.ts) — chatId/tenantId/userId/turnId
 *   - `DebugRpcHost` (debug-rpcs.ts) — env, workspace, message store,
 *     rate-limit driver, presence iteration
 *
 * The two overlapped (both wanted `chatId`/`tenantId`/`userId`), so
 * we collapse them here. The agent `implements AgentHost` once.
 *
 * `env` is exposed via a method (not a field) because the agents base
 * class declares `env` as `protected` — we can't satisfy a `readonly env`
 * interface field through straight implementation.
 */
import type { Workspace } from "@cloudflare/shell";
import type { ChatContextStore } from "./chat-context";
import type { DataDbHandle } from "./data-db";
import type { Env } from "./env";
import type { EnvelopeProvider } from "./turn-logger";

export interface AgentHost extends EnvelopeProvider {
  /** The DO name == chatId. */
  readonly name: string;
  readonly workspace: Workspace;
  readonly dataDbCache: DataDbHandle;
  /** Lazy chat-context store; used for prompt rendering + envelope tenant. */
  readonly chatContext: ChatContextStore;
  /** The user who sent the most recent message — read in audit/log
   *  envelopes. Public-mutable: `onMessage` updates it before the
   *  turn fires. */
  lastSenderUserId: string | null;

  /** Resolve the worker env. Method (not field) — see top-of-file note. */
  getEnv(): Env;
  /** Read persisted message history (proxies Think.getMessages()). */
  getPersistedMessages(): unknown[];
  /** Wipe persisted message history (proxies Think.clearMessages()). */
  clearPersistedMessages(): void;
  /** Iterate live WS connections for presence dumps. The state shape
   *  is loosely typed because partyserver's `ConnectionState<T>` is
   *  `ImmutableObject<T> | null`, which makes a generic `S | undefined`
   *  interface unassignable. Callers narrow at the read site. */
  getConnections(): Iterable<{ state: unknown }>;
}
