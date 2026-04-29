/**
 * Chat-context store — the per-DO cache + lazy resolver for control-plane
 * chat metadata (title, attached dbProfile).
 *
 * Earlier the agent class held `cachedChatContext` as a public mutable,
 * implemented `resolveChatContext()` inline (50+ LOC of Drizzle dual-query),
 * exposed `invalidateChatContext()` for debug RPCs, and the title-summarizer
 * mutated the cache via an `onApplied` callback. Cache concerns sprayed
 * across four sites; one source of truth was missing.
 *
 * `ChatContextStore` collapses all of it:
 *   - `get()` lazy-resolves once, caches; never throws (logs + returns null)
 *   - `peek()` sync read for the system-prompt fallback path
 *   - `setTitle(t)` patches the cached title (used by title summarizer)
 *   - `replace(ctx)` full replace (used by the `setChatContext` RPC)
 *   - `invalidate()` reset (used after `dataDbReset`)
 *
 * Callers never construct a `ChatContext` directly — they go through
 * the store, so the cache stays consistent with the resolver.
 */
import { logEvent, truncateMessage } from "@data-agent/shared";
import { readSecret, type Env } from "./env";
import type { ChatContext } from "./system-prompt";

export class ChatContextStore {
  private cache: ChatContext | undefined;

  constructor(
    private readonly env: Env,
    private readonly chatId: string
  ) {}

  /**
   * Lazy-resolve the chat context from the control-plane on the first
   * call, return cached value afterwards. Errors are caught + logged
   * so a control-plane blip never blocks a turn.
   */
  async get(): Promise<ChatContext | undefined> {
    if (this.cache) return this.cache;
    try {
      this.cache = await this.resolve();
    } catch (err) {
      logEvent({
        event: "chat.context_resolve_failed",
        level: "warn",
        chatId: this.chatId,
        error: truncateMessage(err),
      });
    }
    return this.cache;
  }

  /** Sync read — used by getSystemPrompt's fallback path + envelope getter. */
  peek(): ChatContext | undefined {
    return this.cache;
  }

  /**
   * Patch the cached title in place. Used by the title summarizer's
   * `onApplied` callback so the next turn's system prompt reflects the
   * fresh title without a control-plane round-trip. No-op when the
   * cache is empty (we'd be patching a value that hasn't been resolved
   * yet — the next `get()` will pick up the persisted value).
   */
  setTitle(title: string): void {
    if (this.cache) this.cache.chatTitle = title;
  }

  /** Full replace — used by the `setChatContext` RPC. */
  replace(ctx: ChatContext): void {
    this.cache = ctx;
  }

  /** Reset — used after `dataDbReset` so a new dbProfile is picked up. */
  invalidate(): void {
    this.cache = undefined;
  }

  /**
   * Read chat title + (optional) attached dbProfile metadata from the
   * control-plane. We do NOT include user identity here — multi-user
   * chats have several users, and the prompt is shared.
   */
  private async resolve(): Promise<ChatContext> {
    const { createDbClient, schema } = await import("@data-agent/db");
    const { eq } = await import("drizzle-orm");
    const url = await readSecret(this.env.CONTROL_PLANE_DB_URL);
    const { db, client } = createDbClient({ url, max: 2 });
    try {
      const [chat] = await db
        .select({
          title: schema.chat.title,
          tenantId: schema.chat.tenantId,
          dbProfileId: schema.chat.dbProfileId,
        })
        .from(schema.chat)
        .where(eq(schema.chat.id, this.chatId))
        .limit(1);

      const ctx: ChatContext = {
        chatTitle: chat?.title,
        tenantId: chat?.tenantId,
        dbProfileId: chat?.dbProfileId ?? null,
      };
      if (chat?.dbProfileId) {
        const [profile] = await db
          .select({
            name: schema.dbProfile.name,
            host: schema.dbProfile.host,
            database: schema.dbProfile.database,
          })
          .from(schema.dbProfile)
          .where(eq(schema.dbProfile.id, chat.dbProfileId))
          .limit(1);
        if (profile) ctx.database = profile;
      }
      return ctx;
    } finally {
      void client.end({ timeout: 1 }).catch(() => {});
    }
  }
}
