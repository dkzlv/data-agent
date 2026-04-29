/**
 * ChatRoom — the live chat UI.
 *
 * Connects to the api-gateway via WebSocket using the agents SDK
 * (`useAgent({ basePath })` so we hit our own routing layer rather than
 * the SDK's default `/agents/<class>/<name>` shape). Every message is
 * persisted server-side via Think; we get streamed text + tool calls +
 * resumable streaming for free.
 *
 * UI primitives are shadcn (Button, Textarea, Badge, Sheet, ...) so
 * the chat respects the global theme tokens. The composer + message
 * list shells get tight initial-load skeletons while the WebSocket
 * is still negotiating + receiving the first message sync — the
 * earlier "Loading…" string caused a visible layout pop on each
 * navigation into a chat.
 */
import type { FormEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Send, ChevronRight, ChartBar, Users } from "lucide-react";
import { ArtifactViewer, asArtifactRef } from "./ArtifactViewer";
import { WorkspaceSidebar, WorkspaceSidebarBody } from "./WorkspaceSidebar";
import { getChatHost } from "~/lib/chat-host";
import { type FriendlyError, toFriendlyError } from "~/lib/agent-error";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Skeleton } from "~/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "~/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

export interface ChatMemberSummary {
  userId: string;
  name: string;
  email: string;
  role: "owner" | "participant";
}

interface ChatRoomProps {
  chatId: string;
  /** Optional title shown above the message list. */
  title?: string;
  /** Members of this chat — used to render presence display names. */
  members?: ChatMemberSummary[];
}

export function ChatRoom({ chatId, title, members = [] }: ChatRoomProps): React.ReactElement {
  const host = useMemo(() => getChatHost(), []);
  const basePath = `api/chats/${encodeURIComponent(chatId)}/ws`;
  const qc = useQueryClient();
  // Live title pushed by the chat-agent's auto-summarizer (subtask
  // 16656a). When the broadcast arrives we both update local state
  // (so the header re-renders immediately) AND invalidate the chats
  // list query so the sidebar / index page reflect the new title.
  // `undefined` = no live update yet → fall back to the prop.
  const [liveTitle, setLiveTitle] = useState<string | undefined>(undefined);
  // Reset when navigating between chats.
  useEffect(() => {
    setLiveTitle(undefined);
  }, [chatId]);

  // Diagnostic: surface the WS target in the browser console so a
  // debug session can immediately verify which host the agents SDK is
  // pointing at.
  if (typeof window !== "undefined") {
    // eslint-disable-next-line no-console
    console.log("[chat-room] WS target", {
      host,
      basePath,
      url: `wss://${host}/${basePath}`,
      apiEnv: (window as unknown as { __ENV__?: { API_URL?: string } }).__ENV__,
    });
  }

  const agent = useAgent({
    host,
    agent: "ChatAgent",
    name: chatId,
    // basePath bypasses the agents SDK's default `/agents/<class>/<name>`
    // URL — we route everything through the api-gateway's authenticated
    // upgrade endpoint, which mints a chat-token JWT and forwards on the
    // service binding.
    basePath,
  });

  const chat = useAgentChat({
    agent,
    credentials: "include",
  });

  // WS-ready gate. We render skeletons until the WebSocket has
  // opened *and* the agent's first message snapshot has flowed in
  // (`cf_agent_messages` payload, surfaced via the `message` event
  // on the connection). Without this, the chat momentarily shows
  // "no messages" before the existing transcript appears.
  const [wsOpen, setWsOpen] = useState(false);
  const [hasInitialSync, setHasInitialSync] = useState(false);
  const isReady = wsOpen && hasInitialSync;

  // Diagnostic: log every WS lifecycle event with timestamps so any
  // disconnect / failure-to-connect can be correlated with server-side
  // `chat.ws.close` events in Workers Logs.
  useEffect(() => {
    const openedAt = { current: 0 };
    const onOpen = () => {
      openedAt.current = Date.now();
      setWsOpen(true);
      console.log("[chat-room] WS open", {
        at: new Date().toISOString(),
        chatId,
      });
    };
    const onClose = (e: CloseEvent) => {
      setWsOpen(false);
      const sessionMs = openedAt.current ? Date.now() - openedAt.current : null;
      const codeLabels: Record<number, string> = {
        1000: "normal",
        1001: "going_away",
        1006: "abnormal_no_close_frame",
        1011: "server_error",
        1012: "service_restart",
        1013: "try_again_later",
      };
      console.warn("[chat-room] WS close", {
        at: new Date().toISOString(),
        chatId,
        code: e.code,
        codeLabel: codeLabels[e.code] ?? "unknown",
        reason: e.reason || "(empty)",
        wasClean: e.wasClean,
        sessionMs,
        documentVisibility: typeof document !== "undefined" ? document.visibilityState : null,
        online: typeof navigator !== "undefined" ? navigator.onLine : null,
      });
    };
    const onError = (e: Event) =>
      console.error("[chat-room] WS error", {
        at: new Date().toISOString(),
        chatId,
        event: e,
      });
    agent.addEventListener("open", onOpen);
    agent.addEventListener("close", onClose);
    agent.addEventListener("error", onError);
    return () => {
      agent.removeEventListener("open", onOpen);
      agent.removeEventListener("close", onClose);
      agent.removeEventListener("error", onError);
    };
  }, [agent, chatId]);

  // Presence + initial-sync detector. The agents SDK sends an
  // initial `cf_agent_messages` payload right after upgrade; we treat
  // its arrival as the "transcript loaded" signal regardless of
  // length (zero-length messages → empty state, not skeleton).
  const [presence, setPresence] = useState<{ userId: string; joinedAt: number }[]>([]);
  const memberDirectory = useMemo(() => {
    const map = new Map<string, ChatMemberSummary>();
    for (const m of members) map.set(m.userId, m);
    return map;
  }, [members]);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const raw = typeof e.data === "string" ? e.data : "";
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw) as {
          type?: string;
          users?: { userId: string; joinedAt: number }[];
          chatId?: string;
          title?: string;
        };
        if (parsed.type === "data_agent_presence" && Array.isArray(parsed.users)) {
          setPresence(parsed.users);
        }
        if (parsed.type === "cf_agent_messages") {
          setHasInitialSync(true);
        }
        // Auto-title broadcast (subtask 16656a). Update the header
        // immediately and invalidate the chats list + per-chat metadata
        // so all surfaces reflect the new title.
        if (parsed.type === "data_agent_title" && typeof parsed.title === "string") {
          setLiveTitle(parsed.title);
          qc.invalidateQueries({ queryKey: ["chats"] });
          qc.invalidateQueries({ queryKey: ["chat", chatId] });
        }
      } catch {
        // not our message
      }
    };
    agent.addEventListener("message", onMsg);
    return () => agent.removeEventListener("message", onMsg);
  }, [agent, qc, chatId]);

  // Safety net: if the SDK uses a different sync envelope, fall back
  // to "WS open + 600ms grace" so we never get stuck on the skeleton.
  useEffect(() => {
    if (!wsOpen || hasInitialSync) return;
    const t = setTimeout(() => setHasInitialSync(true), 600);
    return () => clearTimeout(t);
  }, [wsOpen, hasInitialSync]);

  const displayedTitle = liveTitle ?? title;

  return (
    <div className="flex h-[calc(100dvh-7rem)] flex-col gap-3">
      {displayedTitle ? (
        <header className="flex items-center justify-between gap-3 border-b border-border pb-3">
          <h1 className="truncate text-lg font-semibold tracking-tight sm:text-xl">
            {displayedTitle}
          </h1>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <PresenceBadges users={presence} directory={memberDirectory} />
            <MembersPopover members={members} active={presence} />
            <WorkspaceMobileTrigger chatId={chatId} />
          </div>
        </header>
      ) : null}

      <div className="flex flex-1 gap-0 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {isReady ? (
            <MessageList
              messages={chat.messages as UIMessage[]}
              status={chat.status}
              error={chat.error}
            />
          ) : (
            <MessageListSkeleton />
          )}

          <Composer
            disabled={!isReady || chat.status === "streaming" || chat.status === "submitted"}
            onSubmit={(text) => {
              chat.sendMessage({
                role: "user",
                parts: [{ type: "text", text }],
              });
            }}
          />
        </div>

        <WorkspaceSidebar chatId={chatId} />
      </div>
    </div>
  );
}

/**
 * Mobile-only header button that opens the workspace as a slide-over
 * Sheet. The desktop sidebar is permanently visible (md:flex) so this
 * is hidden on md+.
 */
function WorkspaceMobileTrigger({ chatId }: { chatId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Open workspace">
          <ChartBar className="h-4 w-4" />
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-80 p-0">
        <SheetHeader className="sr-only">
          <SheetTitle>Workspace</SheetTitle>
        </SheetHeader>
        <WorkspaceSidebarBody chatId={chatId} />
      </SheetContent>
    </Sheet>
  );
}

function MessageListSkeleton() {
  // Roughly mirrors the MessageList container + a few message bubbles.
  // Three bubbles: user (right), assistant (left), assistant streaming
  // (left, longer). Heights chosen to match the real bubble padding.
  return (
    <div
      className="flex-1 space-y-4 overflow-hidden rounded-lg border border-border bg-card p-4"
      aria-busy="true"
      aria-label="Loading chat"
    >
      <div className="flex justify-end">
        <Skeleton className="h-9 w-2/3 rounded-2xl sm:w-1/2" />
      </div>
      <div className="flex justify-start">
        <Skeleton className="h-16 w-3/4 rounded-2xl sm:w-2/3" />
      </div>
      <div className="flex justify-start">
        <Skeleton className="h-12 w-1/2 rounded-2xl" />
      </div>
    </div>
  );
}

function MessageList({
  messages,
  status,
  error,
}: {
  messages: UIMessage[];
  status: string;
  error?: Error;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  const friendly = toFriendlyError(error);

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    if (!ref.current) return;
    ref.current.scrollTop = ref.current.scrollHeight;
  }, [messages.length, status]);

  return (
    <div
      ref={ref}
      className="flex-1 space-y-4 overflow-y-auto rounded-lg border border-border bg-card p-4"
    >
      {messages.length === 0 && <EmptyState />}
      {messages.map((m) => (
        <MessageBubble key={m.id} message={m} />
      ))}
      {status === "streaming" && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-flex gap-0.5">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground" />
          </span>
          thinking
        </p>
      )}
      {/*
        We render the error banner as the *last* item in the message
        list (rather than a fixed banner at the top) so it appears
        in-context with the failed turn.
      */}
      {friendly && <ErrorBanner friendly={friendly} />}
      {status === "error" && !friendly && (
        <p className="text-xs text-destructive">Connection error — reconnecting…</p>
      )}
    </div>
  );
}

function ErrorBanner({ friendly }: { friendly: FriendlyError }) {
  const variant: "destructive" | "warn" | "info" =
    friendly.severity === "error" ? "destructive" : friendly.severity === "warn" ? "warn" : "info";
  return (
    <Alert variant={variant}>
      <AlertTitle>{friendly.title}</AlertTitle>
      {friendly.detail ? <AlertDescription>{friendly.detail}</AlertDescription> : null}
    </Alert>
  );
}

function EmptyState(): React.ReactElement {
  return (
    <div className="space-y-2 py-12 text-center text-sm text-muted-foreground">
      <p className="text-base font-medium text-foreground">Ask anything about your data</p>
      <p>Try: "list all tables and how many rows each has"</p>
      <p>Or: "show revenue by month for the last 6 months as a line chart"</p>
    </div>
  );
}

interface UIPart {
  type: string;
  text?: string;
  state?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

function MessageBubble({ message }: { message: UIMessage }) {
  const isUser = message.role === "user";
  const parts = (message.parts as unknown as UIPart[]) ?? [];
  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div
        className={cn(
          "max-w-[78ch] rounded-2xl px-4 py-3 text-sm",
          isUser ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
        )}
      >
        {parts.map((part, i) => (
          <PartRender key={i} part={part} isUser={isUser} />
        ))}
      </div>
    </div>
  );
}

function PartRender({
  part,
  isUser,
}: {
  part: UIPart;
  isUser: boolean;
}): React.ReactElement | null {
  if (part.type === "text" && typeof part.text === "string") {
    if (isUser) {
      return <p className="whitespace-pre-wrap leading-relaxed">{part.text}</p>;
    }
    return (
      <div className="markdown-body break-words leading-relaxed">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown>
      </div>
    );
  }
  if (part.type === "reasoning") {
    return <ReasoningPart part={part} />;
  }
  if (part.type?.startsWith("tool-")) {
    return <ToolPart part={part} />;
  }
  if (part.type === "step-start" || part.type === "step-end") {
    return null;
  }
  return (
    <pre className="my-1 overflow-x-auto rounded bg-foreground/10 p-2 text-[11px]">
      {JSON.stringify(part, null, 2)}
    </pre>
  );
}

function ReasoningPart({ part }: { part: UIPart }) {
  const text = part.text ?? "";
  const streaming = part.state === "streaming";
  const preview = (() => {
    const trimmed = text.trim();
    const firstLine = trimmed.split(/\n/, 1)[0] ?? "";
    if (firstLine.length <= 120) return firstLine;
    return firstLine.slice(0, 117) + "…";
  })();

  return (
    <details className="group my-1 text-[12px]" open={streaming}>
      <summary className="flex cursor-pointer select-none items-center gap-1.5 text-muted-foreground transition hover:text-foreground">
        <ChevronRight className="h-3 w-3 shrink-0 transition group-open:rotate-90" />
        <span className="font-medium uppercase tracking-wide text-[10px]">Thinking</span>
        {streaming && (
          <span
            className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground"
            aria-label="thinking"
          />
        )}
        {!streaming && preview && (
          <span className="truncate font-normal italic text-muted-foreground/80 group-open:hidden">
            {preview}
          </span>
        )}
      </summary>
      <div className="mt-1 ml-4 whitespace-pre-wrap border-l-2 border-border pl-3 italic leading-relaxed text-muted-foreground">
        {text}
      </div>
    </details>
  );
}

function ToolPart({ part }: { part: UIPart }) {
  const rawToolName = part.toolName ?? part.type?.replace(/^tool-/, "") ?? "tool";
  const isCodemode = rawToolName === "codemode";
  const status =
    part.state === "output-available" ? "ok" : part.state === "output-error" ? "err" : "run";

  const artifact = part.output != null ? asArtifactRef(part.output) : null;

  const codemodeInput = isCodemode ? extractCodemodeCode(part.input) : null;
  const codemodeOutput = isCodemode ? extractCodemodeResult(part.output) : null;

  const summaryLabel = isCodemode ? "ran code" : rawToolName;
  const statusBadgeCls = {
    ok: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    err: "bg-destructive/15 text-destructive",
    run: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  }[status];
  const statusLabel = { ok: "✓", err: "✗", run: "…" }[status];

  const errorSummary =
    status === "err" && part.errorText ? summarizeToolError(rawToolName, part.errorText) : null;

  return (
    <div className="my-1 space-y-1">
      {artifact ? <ArtifactViewer ref={artifact} /> : null}
      {errorSummary && (
        <p className="text-xs text-destructive">
          <span className="font-medium">{errorSummary.headline}</span>
          {errorSummary.detail ? (
            <>
              {" — "}
              <span className="opacity-80">{errorSummary.detail}</span>
            </>
          ) : null}
        </p>
      )}
      <details className="group rounded-lg border border-border bg-background/40 text-xs">
        <summary className="flex cursor-pointer select-none items-center gap-2 px-2.5 py-1.5">
          <span
            className={cn(
              "inline-flex h-4 w-4 items-center justify-center rounded text-[10px] font-bold leading-none",
              statusBadgeCls
            )}
            aria-label={status}
          >
            {statusLabel}
          </span>
          <span className="font-medium text-foreground/80">{summaryLabel}</span>
          {isCodemode && codemodeInput && (
            <span className="ml-1 truncate font-mono text-[10px] text-muted-foreground">
              {summarizeCode(codemodeInput)}
            </span>
          )}
          <ChevronRight className="ml-auto h-3 w-3 shrink-0 text-muted-foreground transition group-open:rotate-90" />
        </summary>

        <div className="space-y-2 border-t border-border px-2.5 py-2">
          {isCodemode && codemodeInput && (
            <div>
              <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Code
              </div>
              <pre className="max-h-72 overflow-auto rounded bg-muted/50 px-2 py-1.5 font-mono text-[11px] leading-snug">
                {codemodeInput}
              </pre>
            </div>
          )}
          {isCodemode && codemodeOutput !== null && (
            <div>
              <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Result
              </div>
              <pre className="max-h-72 overflow-auto rounded bg-muted/50 px-2 py-1.5 font-mono text-[11px] leading-snug">
                {codemodeOutput}
              </pre>
            </div>
          )}

          {!isCodemode && part.input != null && (
            <div>
              <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Input
              </div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 px-2 py-1.5 font-mono text-[11px] leading-snug">
                {safeJsonStringify(part.input)}
              </pre>
            </div>
          )}
          {!isCodemode && part.output != null && (
            <div>
              <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Output
              </div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 px-2 py-1.5 font-mono text-[11px] leading-snug">
                {safeJsonStringify(part.output)}
              </pre>
            </div>
          )}
          {part.errorText && <p className="text-destructive">{part.errorText}</p>}
        </div>
      </details>
    </div>
  );
}

function extractCodemodeCode(input: unknown): string | null {
  if (input == null) return null;
  let obj: unknown = input;
  if (typeof obj === "string") {
    const raw = obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  if (typeof obj === "object" && obj !== null) {
    const code = (obj as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

function extractCodemodeResult(output: unknown): string | null {
  if (output == null) return null;
  let obj: unknown = output;
  if (typeof obj === "string") {
    const raw = obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  if (typeof obj === "object" && obj !== null) {
    const result = (obj as { result?: unknown }).result;
    if (result === undefined) return safeJsonStringify(obj);
    if (typeof result === "string") return result;
    return safeJsonStringify(result);
  }
  return safeJsonStringify(obj);
}

function summarizeCode(code: string): string {
  const stripped = code
    .replace(/^\s*async\s*\(\s*\)\s*=>\s*\{?\s*/i, "")
    .replace(/\}\s*$/, "")
    .trim();
  const firstLine = stripped.split(/\n/).find((l) => l.trim().length > 0) ?? stripped;
  const compact = firstLine.replace(/\s+/g, " ").trim();
  return compact.length > 80 ? compact.slice(0, 77) + "…" : compact;
}

function safeJsonStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function summarizeToolError(
  toolName: string,
  errorText: string
): { headline: string; detail?: string } {
  const t = errorText.toLowerCase();
  if (t.includes("statement timeout") || t.includes("canceling statement"))
    return {
      headline: "Database query timed out",
      detail: "Try a smaller scan or add a tighter `WHERE`.",
    };
  if (t.includes("permission denied") || t.includes("must be owner"))
    return {
      headline: "Database refused the query",
      detail: "The agent's role doesn't have access to that table.",
    };
  if (t.includes("relation") && t.includes("does not exist"))
    return {
      headline: "Table doesn't exist",
      detail: errorText.slice(0, 140),
    };
  if (t.includes("syntax error"))
    return {
      headline: "SQL syntax error",
      detail: errorText.slice(0, 140),
    };
  if (t.includes("read-only") || t.includes("read only"))
    return {
      headline: "Only SELECT queries are allowed",
      detail: "The agent can't run mutations.",
    };
  if (t.includes("sandbox") && t.includes("timeout"))
    return {
      headline: "Tool ran out of time",
      detail: "The data step took longer than 30 seconds.",
    };
  const detail = errorText.length > 160 ? `${errorText.slice(0, 160)}…` : errorText;
  return { headline: `${toolName} failed`, detail };
}

function MembersPopover({
  members,
  active,
}: {
  members: ChatMemberSummary[];
  active: { userId: string; joinedAt: number }[];
}) {
  const [open, setOpen] = useState(false);
  if (members.length === 0) return null;
  const activeIds = new Set(active.map((u) => u.userId));
  return (
    <div className="relative">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup
        aria-expanded={open}
        className="gap-1.5"
      >
        <Users className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">
          {members.length} member{members.length === 1 ? "" : "s"}
        </span>
        <span className="sm:hidden">{members.length}</span>
      </Button>
      {open && (
        <div
          role="dialog"
          className="absolute right-0 top-full z-10 mt-1 w-64 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
          onMouseLeave={() => setOpen(false)}
        >
          <ul className="max-h-72 overflow-y-auto py-1">
            {members.map((m) => (
              <li key={m.userId} className="flex items-center gap-2 px-3 py-2 text-xs">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{
                    background: activeIds.has(m.userId) ? "#10b981" : "#a3a3a3",
                  }}
                  aria-label={activeIds.has(m.userId) ? "online" : "offline"}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-foreground">
                    {m.name || m.email}
                  </span>
                  {m.name && (
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {m.email}
                    </span>
                  )}
                </span>
                <Badge variant="muted" className="text-[10px] uppercase">
                  {m.role}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function PresenceBadges({
  users,
  directory,
}: {
  users: { userId: string; joinedAt: number }[];
  directory: Map<string, ChatMemberSummary>;
}) {
  if (users.length <= 1) return null;
  const visible = users.slice(0, 4);
  const overflow = users.length - visible.length;
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex -space-x-1.5">
        {visible.map((u) => {
          const member = directory.get(u.userId);
          const display = member?.name ?? member?.email ?? u.userId;
          const initials = nameToInitials(display);
          return (
            <Tooltip key={u.userId}>
              <TooltipTrigger asChild>
                <span
                  className="inline-flex h-6 w-6 items-center justify-center rounded-full border-2 border-background text-[9px] font-semibold uppercase text-foreground/70 ring-1 ring-border"
                  style={{ background: idToColor(u.userId) }}
                >
                  {initials}
                </span>
              </TooltipTrigger>
              <TooltipContent>{display}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      {overflow > 0 && <span className="text-[10px] text-muted-foreground">+{overflow}</span>}
    </div>
  );
}

function nameToInitials(name: string): string {
  const trimmed = name.includes("@") ? name.split("@")[0]! : name;
  const parts = trimmed.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return ((parts[0]?.[0] ?? "") + (parts[parts.length - 1]?.[0] ?? "")).toUpperCase();
  }
  return (parts[0] ?? "").slice(0, 2).toUpperCase() || "?";
}

function idToColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `oklch(0.78 0.09 ${hue})`;
}

function Composer({ disabled, onSubmit }: { disabled: boolean; onSubmit: (text: string) => void }) {
  const [text, setText] = useState("");
  const send = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const trimmed = text.trim();
      if (!trimmed || disabled) return;
      onSubmit(trimmed);
      setText("");
    },
    [text, disabled, onSubmit]
  );

  return (
    <form onSubmit={send} className="flex items-end gap-2">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={
          disabled
            ? "Waiting for response…"
            : "Ask about your data — e.g. 'top 10 customers by revenue this quarter'"
        }
        disabled={disabled}
        rows={2}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
            e.preventDefault();
            send(e as unknown as FormEvent);
          }
        }}
        className="min-h-[3rem] flex-1 resize-y"
      />
      <Button
        type="submit"
        disabled={disabled || !text.trim()}
        size="lg"
        className="self-stretch"
        aria-label="Send"
      >
        <Send className="h-4 w-4" />
        <span className="hidden sm:inline">Send</span>
      </Button>
    </form>
  );
}
