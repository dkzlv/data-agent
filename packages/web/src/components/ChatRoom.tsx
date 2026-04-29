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
import type { FormEvent, KeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import TextareaAutosize from "react-textarea-autosize";
import {
  ArrowUp,
  ChartBar,
  ChevronRight,
  Code2,
  Database,
  FileText,
  Image as ImageIcon,
  Square,
  Terminal,
  Users,
  Wrench,
} from "lucide-react";
import { ArtifactViewer, asArtifactRef } from "./ArtifactViewer";
import { CodeBlock } from "./CodeBlock";
import { WorkspaceSidebar, WorkspaceSidebarBody } from "./WorkspaceSidebar";
import { getChatHost } from "~/lib/chat-host";
import { type FriendlyError, toFriendlyError } from "~/lib/agent-error";
import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton } from "~/components/ui/input-group";
import { Skeleton } from "~/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import {
  ScrollAreaRoot,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaViewport,
} from "~/components/ui/scroll-area";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "~/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { EMPLOYEES_DEMO_PROMPTS } from "~/lib/sample-db";
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
  /**
   * True when this chat is attached to the auto-seeded sample DB.
   * Renders demo prompt chips above the composer (only while there
   * are no messages yet) and tweaks the empty-state copy. Caller
   * resolves this from the chat's `dbProfileId` so ChatRoom stays
   * decoupled from the db-profiles fetch.
   */
  isSampleDb?: boolean;
}

export function ChatRoom({
  chatId,
  title,
  members = [],
  isSampleDb = false,
}: ChatRoomProps): React.ReactElement {
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

  // Stable send callback shared by the composer and demo-suggestion
  // chips. Both surfaces want exactly the same behavior: trim, drop
  // empties, fire as a user message. Centralizing it keeps the two
  // entry points consistent (and means future logging / optimistic
  // UI lives in one place).
  const handleSend = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      chat.sendMessage({
        role: "user",
        parts: [{ type: "text", text: trimmed }],
      });
    },
    [chat]
  );

  // True while a turn is in flight — covers both the user-initiated
  // request/response cycle (`status`) and any server-initiated stream
  // (auto-continuation after a tool call, recovery push from another
  // tab). When this is true the composer flips its submit affordance
  // to a stop button so the user can interrupt without typing.
  const isTurnInFlight =
    chat.status === "streaming" || chat.status === "submitted" || chat.isServerStreaming;

  // The composer itself is only fully disabled until the WS is ready
  // (i.e. you can't type into a not-yet-connected chat). While a turn
  // is in flight, the textarea stays enabled so the user can compose
  // their next message — they just can't *send* it until the current
  // turn completes (the submit button becomes a stop button).
  const composerLocked = !isReady;
  const handleStop = useCallback(() => {
    chat.stop();
  }, [chat]);
  // Chips show only on a fresh sample-DB chat. They disappear the
  // moment the first message lands (whether sent via chip or typed)
  // because `chat.messages.length` becomes > 0.
  const showDemoSuggestions = isSampleDb && isReady && chat.messages.length === 0;

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
              isSampleDb={isSampleDb}
            />
          ) : (
            <MessageListSkeleton />
          )}

          {showDemoSuggestions && (
            <DemoSuggestions
              prompts={EMPLOYEES_DEMO_PROMPTS}
              disabled={composerLocked || isTurnInFlight}
              onPick={handleSend}
            />
          )}

          <Composer
            locked={composerLocked}
            isStreaming={isTurnInFlight}
            onSubmit={handleSend}
            onStop={handleStop}
          />
        </div>

        <WorkspaceSidebar chatId={chatId} />
      </div>
    </div>
  );
}

/**
 * Horizontal wrap of single-tap demo prompts. Click sends the
 * full `prompt` string immediately — `label` is just the chip text.
 */
function DemoSuggestions({
  prompts,
  disabled,
  onPick,
}: {
  prompts: { label: string; prompt: string }[];
  disabled: boolean;
  onPick: (text: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2" aria-label="Demo prompt suggestions">
      {prompts.map((p) => (
        <Button
          key={p.label}
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onPick(p.prompt)}
          title={p.prompt}
        >
          {p.label}
        </Button>
      ))}
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
  isSampleDb,
}: {
  messages: UIMessage[];
  status: string;
  error?: Error;
  isSampleDb: boolean;
}): React.ReactElement {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  // "stickToBottom" autoscroll: as long as the user is scrolled to
  // (or near) the bottom we follow new content. The moment they scroll
  // up — to re-read an earlier turn or to inspect a chart — we stop
  // pinning so the page doesn't yank under them. Re-engages when they
  // scroll back to within 32px of the bottom.
  const [stickToBottom, setStickToBottom] = useState(true);
  const friendly = toFriendlyError(error);

  // Track every chunk: messages count, last message's parts length,
  // and the text length of the streaming text part. The earlier
  // implementation only watched `messages.length` + `status`, which
  // missed the in-message growth — long answers visibly drifted off
  // the bottom while the model was still talking.
  const scrollKey = useMemo(() => {
    const last = messages[messages.length - 1];
    if (!last) return `${messages.length}:${status}`;
    const parts = (last.parts as unknown as UIPart[]) ?? [];
    const tail = parts[parts.length - 1];
    const tailLen =
      tail && typeof tail.text === "string"
        ? tail.text.length
        : tail
          ? JSON.stringify(tail).length
          : 0;
    return `${messages.length}:${parts.length}:${tailLen}:${status}`;
  }, [messages, status]);

  useEffect(() => {
    if (!stickToBottom) return;
    const v = viewportRef.current;
    if (!v) return;
    // rAF so the DOM has measured the new content first; double rAF
    // matters for streaming markdown where the layout reflows after
    // a synchronous setState on the message store.
    const id1 = requestAnimationFrame(() => {
      const id2 = requestAnimationFrame(() => {
        v.scrollTop = v.scrollHeight;
      });
      // Cancel only the inner frame; outer ran already.
      return () => cancelAnimationFrame(id2);
    });
    return () => cancelAnimationFrame(id1);
  }, [scrollKey, stickToBottom]);

  // Detect user-driven scroll-up to disable stickiness, and re-engage
  // when they return to the bottom. 32px is a comfortable epsilon
  // that survives fractional-pixel rounding on hi-DPI displays.
  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setStickToBottom(distanceFromBottom < 32);
  }, []);

  return (
    <ScrollAreaRoot className="flex-1 rounded-lg border border-border bg-card">
      <ScrollAreaViewport ref={viewportRef} onScroll={onScroll} className="h-full max-h-full p-4">
        <div className="space-y-4">
          {messages.length === 0 && <EmptyState isSampleDb={isSampleDb} />}
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
          {status === "submitted" && (
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
      </ScrollAreaViewport>
      <ScrollAreaScrollbar>
        <ScrollAreaThumb />
      </ScrollAreaScrollbar>
    </ScrollAreaRoot>
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

function EmptyState({ isSampleDb }: { isSampleDb: boolean }): React.ReactElement {
  if (isSampleDb) {
    return (
      <div className="space-y-2 py-12 text-center text-sm text-muted-foreground">
        <p className="text-base font-medium text-foreground">Try the employees demo</p>
        <p>Click a prompt below or type your own.</p>
      </div>
    );
  }
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

  // Track elapsed thinking time. We start the clock the first time
  // we see this part and freeze it the moment streaming flips false
  // (i.e. the model emitted its final reasoning chunk). Persisting
  // the frozen value across rerenders means the label stays stable
  // ("Thought for 12s") even after the message is fully delivered
  // — refreshing the chat won't reset it because the frozen value
  // is recomputed from the (effectively constant) text length.
  const startedAt = useRef<number | null>(null);
  const [tick, setTick] = useState(0);
  const [frozenSeconds, setFrozenSeconds] = useState<number | null>(null);

  useEffect(() => {
    if (!streaming) return;
    if (startedAt.current == null) startedAt.current = Date.now();
    const id = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, [streaming]);

  useEffect(() => {
    // The first non-streaming render after streaming → freeze the
    // elapsed value. After this `frozenSeconds` carries the label.
    if (!streaming && startedAt.current != null && frozenSeconds == null) {
      const elapsed = Math.max(1, Math.round((Date.now() - startedAt.current) / 1000));
      setFrozenSeconds(elapsed);
    }
  }, [streaming, frozenSeconds]);

  const seconds = (() => {
    if (frozenSeconds != null) return frozenSeconds;
    if (streaming && startedAt.current != null) {
      // tick is referenced so the closure recomputes on every interval.
      void tick;
      return Math.max(1, Math.round((Date.now() - startedAt.current) / 1000));
    }
    // Edge case: we mounted with the part already finished (e.g. a
    // recovered message replay). Estimate from text length so the
    // label isn't suspiciously "0s". Roughly 30 chars/sec is a
    // reasonable lower bound for reasoning streams.
    const trimmed = text.trim();
    if (!trimmed) return 1;
    return Math.max(1, Math.round(trimmed.length / 30));
  })();

  const label = streaming ? `Thinking…` : `Thought for ${seconds}s`;

  return (
    <details className="group my-1 text-[12px]">
      <summary
        className={cn(
          // Match the "Thought for 12s ›" mock: muted, single-line,
          // chevron rotates on open. No box, no borders — it's a quiet
          // affordance that the user can drill into if curious.
          "flex w-fit cursor-pointer select-none items-center gap-1 rounded-md py-0.5 text-muted-foreground/80 transition hover:text-foreground"
        )}
      >
        <span className="text-[13px]">{label}</span>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 transition group-open:rotate-90" />
      </summary>
      {text && (
        <div className="mt-1.5 ml-1 whitespace-pre-wrap border-l-2 border-border pl-3 italic leading-relaxed text-muted-foreground">
          {text}
        </div>
      )}
    </details>
  );
}

/**
 * ToolPart — visual model:
 *
 *   collapsed (default):
 *     ┌──────────────────────────────────────────────────────┐
 *     │ [icon] **Code** Fetch top customers by revenue   ›   │
 *     └──────────────────────────────────────────────────────┘
 *
 *   expanded (click chevron / row):
 *     ┌──────────────────────────────────────────────────────┐
 *     │ [icon] **Code** Fetch top customers by revenue   ⌄   │
 *     ├──────────────────────────────────────────────────────┤
 *     │ ```ts                                                │
 *     │ async () => { ... }                                  │
 *     │ ```                                                  │
 *     │ ──────                                               │
 *     │ result preview (if any)                              │
 *     └──────────────────────────────────────────────────────┘
 *
 * The collapsed view is intentionally slim (text-[13px], py-2) so
 * a turn full of tool calls reads as a list, not a stack of cards.
 */
function ToolPart({ part }: { part: UIPart }) {
  const rawToolName = part.toolName ?? part.type?.replace(/^tool-/, "") ?? "tool";
  const isCodemode = rawToolName === "codemode";
  const status =
    part.state === "output-available" ? "ok" : part.state === "output-error" ? "err" : "run";

  const artifact = part.output != null ? asArtifactRef(part.output) : null;

  const codemodeInput = isCodemode ? extractCodemodeCode(part.input) : null;
  const codemodeOutput = isCodemode ? extractCodemodeResult(part.output) : null;

  const meta = describeTool(rawToolName);
  // Description: for codemode, peeled out of the leading `// ...`
  // comment in the generated code (system prompt enforces this).
  // For other tools, fall back to a tight summary of the input.
  const description = isCodemode
    ? (extractCodemodeDescription(codemodeInput) ?? "Running code")
    : summarizeToolInput(part.input);

  const errorSummary =
    status === "err" && part.errorText ? summarizeToolError(rawToolName, part.errorText) : null;

  // Determine the body language for syntax highlighting. Codemode
  // ships TypeScript-flavoured JS; non-codemode tool inputs are JSON.
  const bodyLanguage: string = isCodemode ? "tsx" : "json";
  const bodyCode = isCodemode
    ? (codemodeInput ?? "")
    : part.input != null
      ? safeJsonStringify(part.input)
      : "";

  return (
    <div className="my-1 space-y-1.5">
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
      <details className="group overflow-hidden rounded-lg border border-border bg-background/40 text-[13px]">
        <summary
          className={cn(
            "flex cursor-pointer select-none items-center gap-2 px-3 py-2",
            "transition-colors hover:bg-muted/40"
          )}
        >
          <ToolIcon icon={meta.icon} status={status} />
          <span className="font-medium text-foreground">{meta.label}</span>
          {description && (
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{description}</span>
          )}
          <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-muted-foreground transition group-open:rotate-90" />
        </summary>

        <div className="space-y-3 border-t border-border bg-background/60 p-3">
          {bodyCode && <CodeBlock code={bodyCode} language={bodyLanguage} className="max-h-80" />}

          {/* Result panel — not all tool calls produce one (e.g. void
              returns, or codemode functions that resolved to undefined). */}
          {isCodemode && codemodeOutput !== null && <ToolResult>{codemodeOutput}</ToolResult>}
          {!isCodemode && part.output != null && (
            <ToolResult>{safeJsonStringify(part.output)}</ToolResult>
          )}

          {part.errorText && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
              {part.errorText}
            </p>
          )}
        </div>
      </details>
    </div>
  );
}

function ToolResult({ children }: { children: string }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Result
      </div>
      <ScrollAreaRoot className="max-h-64 rounded-md border border-border bg-muted/30">
        <ScrollAreaViewport className="max-h-64 px-3 py-2">
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-[1.55] text-foreground/85">
            {children}
          </pre>
        </ScrollAreaViewport>
        <ScrollAreaScrollbar>
          <ScrollAreaThumb />
        </ScrollAreaScrollbar>
        <ScrollAreaScrollbar orientation="horizontal">
          <ScrollAreaThumb />
        </ScrollAreaScrollbar>
      </ScrollAreaRoot>
    </div>
  );
}

/** Per-tool visual identity — icon + the bolded label in the row. */
interface ToolMeta {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}
function describeTool(rawName: string): ToolMeta {
  // Codemode is the meta-tool; visually we surface "Code" + a code icon
  // because the description carries the actual semantic ("Bash", "DB
  // query", etc. would be misleading — the code may do anything).
  if (rawName === "codemode") return { label: "Code", icon: Code2 };
  // Heuristics for any future first-class (non-codemode) tools.
  const n = rawName.toLowerCase();
  if (n.startsWith("db") || n.includes("sql") || n.includes("query"))
    return { label: prettyToolName(rawName), icon: Database };
  if (n.startsWith("chart") || n.includes("vega"))
    return { label: prettyToolName(rawName), icon: ChartBar };
  if (n.startsWith("artifact") || n.includes("file"))
    return { label: prettyToolName(rawName), icon: FileText };
  if (n.includes("bash") || n.includes("shell") || n.includes("terminal"))
    return { label: prettyToolName(rawName), icon: Terminal };
  if (n.includes("image") || n.includes("screenshot"))
    return { label: prettyToolName(rawName), icon: ImageIcon };
  return { label: prettyToolName(rawName), icon: Wrench };
}

function prettyToolName(name: string): string {
  // "db_introspect" / "chart.bar" → "Db introspect" / "Chart bar"
  const cleaned = name.replace(/[._]/g, " ").trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/**
 * Status-tinted icon. We render the tool icon directly (per the
 * mocks — Bash icon, Browser icon, etc.) and indicate state via a
 * subtle color shift rather than a separate badge:
 *   running → muted with a soft pulse
 *   ok      → foreground (default)
 *   err     → destructive
 */
function ToolIcon({
  icon: Icon,
  status,
}: {
  icon: React.ComponentType<{ className?: string }>;
  status: "ok" | "err" | "run";
}) {
  return (
    <Icon
      className={cn(
        "h-4 w-4 shrink-0",
        status === "err" && "text-destructive",
        status === "run" && "animate-pulse text-muted-foreground",
        status === "ok" && "text-foreground/70"
      )}
    />
  );
}

/**
 * Pull a human-readable description out of the first one-or-two
 * leading line-comments in a codemode body. The system prompt asks
 * the model to write `// Fetch top 10 customers by revenue` as the
 * first line; we strip the `//` and any trailing punctuation. If
 * the comment is missing (older messages, or model regression), we
 * return null so the UI falls back to a generic "Running code".
 */
function extractCodemodeDescription(code: string | null): string | null {
  if (!code) return null;
  // Skip leading whitespace / blank lines, then capture consecutive
  // single-line comments. We join up to 2 of them to handle the case
  // where the model writes a wrapped explanation:
  //   // Compute revenue per customer for Q4
  //   // and rank descending.
  const lines = code.split(/\r?\n/);
  const collected: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") {
      if (collected.length > 0) break;
      continue;
    }
    const m = /^\/\/\s?(.*)$/.exec(line);
    if (!m) break;
    const text = m[1].trim();
    if (!text) break;
    collected.push(text);
    if (collected.length >= 2) break;
  }
  if (collected.length === 0) return null;
  let combined = collected.join(" ").replace(/\s+/g, " ").trim();
  // Drop trailing period/colon/semicolon — these read as noise in
  // a single-line label.
  combined = combined.replace(/[.:;]+$/, "");
  if (combined.length > 110) combined = combined.slice(0, 107) + "…";
  return combined || null;
}

/** Generic input → 1-line summary for non-codemode tools. */
function summarizeToolInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") {
    const compact = input.replace(/\s+/g, " ").trim();
    return compact.length > 110 ? compact.slice(0, 107) + "…" : compact;
  }
  if (typeof input === "object") {
    // Prefer well-known summary fields the LLM might pass
    // ("description", "title", "name", "query"). Falls back to a
    // single-line JSON preview otherwise.
    for (const k of ["description", "title", "name", "query", "sql", "url", "path"]) {
      const v = (input as Record<string, unknown>)[k];
      if (typeof v === "string" && v.trim()) {
        const compact = v.replace(/\s+/g, " ").trim();
        return compact.length > 110 ? compact.slice(0, 107) + "…" : compact;
      }
    }
    const json = safeJsonStringify(input).replace(/\s+/g, " ");
    return json.length > 110 ? json.slice(0, 107) + "…" : json;
  }
  return String(input);
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

/**
 * Composer — auto-sizing textarea with a submit / stop button anchored
 * to the bottom-right of the input group. Implementation follows the
 * shadcn `input-group` recipe: the textarea is the primary control
 * (data-slot="input-group-control" gives it the focus styling), and
 * an `align="block-end"` addon row hosts the action button.
 *
 * While a turn is in flight the action flips from Send → Stop. The
 * textarea stays enabled so users can prep their next prompt; only
 * the *submit* path is gated.
 */
function Composer({
  locked,
  isStreaming,
  onSubmit,
  onStop,
}: {
  /** WS not ready yet → textarea fully disabled. */
  locked: boolean;
  /** Turn in flight → submit is replaced by stop. */
  isStreaming: boolean;
  onSubmit: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const send = useCallback(
    (e?: FormEvent) => {
      e?.preventDefault();
      if (locked || isStreaming) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      onSubmit(trimmed);
      setText("");
    },
    [text, locked, isStreaming, onSubmit]
  );

  const handleKey = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter (no shift) submits. Shift+Enter inserts a newline. We
      // don't gate on Cmd/Ctrl — that was a holdover from the older
      // textarea where Enter inserted newlines by default.
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        send();
      }
    },
    [send]
  );

  const placeholder = locked
    ? "Connecting…"
    : "Ask about your data — e.g. 'top 10 customers by revenue this quarter'";

  return (
    <form onSubmit={send}>
      <InputGroup
        className={cn(
          // The input-group ships a 1px border. We keep that and just
          // bump the rounding to match the message-list panel.
          "rounded-lg",
          locked && "opacity-60"
        )}
      >
        <TextareaAutosize
          data-slot="input-group-control"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKey}
          placeholder={placeholder}
          disabled={locked}
          minRows={2}
          maxRows={10}
          className={cn(
            // Mirrors the shadcn recipe: zero its own borders/bg so
            // the InputGroup wrapper provides the visual chrome.
            "flex w-full resize-none bg-transparent px-3 py-2.5 text-sm leading-relaxed",
            "outline-none placeholder:text-muted-foreground",
            "disabled:cursor-not-allowed"
          )}
          aria-label="Message"
        />
        <InputGroupAddon align="block-end" className="px-2 pb-2">
          <span className="hidden text-[11px] text-muted-foreground sm:inline">
            <kbd className="rounded border border-border bg-muted/60 px-1 font-mono text-[10px]">
              Enter
            </kbd>{" "}
            send ·{" "}
            <kbd className="rounded border border-border bg-muted/60 px-1 font-mono text-[10px]">
              Shift
            </kbd>
            +
            <kbd className="rounded border border-border bg-muted/60 px-1 font-mono text-[10px]">
              Enter
            </kbd>{" "}
            newline
          </span>
          {isStreaming ? (
            <InputGroupButton
              type="button"
              size="sm"
              variant="default"
              onClick={onStop}
              className="ml-auto gap-1.5"
              aria-label="Stop generating"
            >
              <Square className="h-3 w-3 fill-current" />
              Stop
            </InputGroupButton>
          ) : (
            <InputGroupButton
              type="submit"
              size="sm"
              variant="default"
              disabled={locked || !text.trim()}
              className="ml-auto gap-1.5"
              aria-label="Send"
            >
              Send
              <ArrowUp className="h-3.5 w-3.5" />
            </InputGroupButton>
          )}
        </InputGroupAddon>
      </InputGroup>
    </form>
  );
}
