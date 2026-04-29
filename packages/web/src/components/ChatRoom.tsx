/**
 * ChatRoom — the live chat UI.
 *
 * Connects to the api-gateway via WebSocket using the agents SDK
 * (`useAgent({ basePath })` so we hit our own routing layer rather than
 * the SDK's default `/agents/<class>/<name>` shape). Every message is
 * persisted server-side via Think; we get streamed text + tool calls +
 * resumable streaming for free.
 *
 * The composer + message list are intentionally minimal — the goal of
 * subtask fa583c is correctness + plumbing, not bespoke design polish.
 * Future tasks add: keyboard shortcuts, retry, tool-call drill-down,
 * multi-user typing indicators, and the artifact viewer (`a4e12f`).
 */
import type { FormEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArtifactViewer, asArtifactRef } from "./ArtifactViewer";
import { getChatHost } from "~/lib/chat-host";

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

  const agent = useAgent({
    host,
    agent: "ChatAgent",
    name: chatId,
    // basePath bypasses the agents SDK's default `/agents/<class>/<name>`
    // URL — we route everything through the api-gateway's authenticated
    // upgrade endpoint, which mints a chat-token JWT and forwards on the
    // service binding.
    basePath: `api/chats/${encodeURIComponent(chatId)}/ws`,
  });

  // useAgentChat manages the AI SDK message timeline + the WS protocol.
  // It also handles resumable streaming on reconnect via the
  // cf_agent_stream_resume_request flow.
  const chat = useAgentChat({
    agent,
    credentials: "include",
  });

  // Presence: the ChatAgent broadcasts `{ type: 'data_agent_presence',
  // users: [{ userId, joinedAt }] }` whenever the connected set changes.
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
        };
        if (parsed.type === "data_agent_presence" && Array.isArray(parsed.users)) {
          setPresence(parsed.users);
        }
      } catch {
        // not our message
      }
    };
    agent.addEventListener("message", onMsg);
    return () => agent.removeEventListener("message", onMsg);
  }, [agent]);

  return (
    <div className="flex h-[calc(100dvh-7rem)] flex-col gap-4">
      {title ? (
        <header className="flex items-center justify-between gap-3 border-b border-neutral-200 pb-3 dark:border-neutral-800">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <div className="flex items-center gap-3 text-xs text-neutral-500">
            <MembersPopover members={members} active={presence} />
            <PresenceBadges users={presence} directory={memberDirectory} />
          </div>
        </header>
      ) : null}

      <MessageList messages={chat.messages as UIMessage[]} status={chat.status} />

      <Composer
        disabled={chat.status === "streaming" || chat.status === "submitted"}
        onSubmit={(text) => {
          chat.sendMessage({
            role: "user",
            parts: [{ type: "text", text }],
          });
        }}
      />
    </div>
  );
}

function MessageList({
  messages,
  status,
}: {
  messages: UIMessage[];
  status: string;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);

  return (
    <div
      ref={ref}
      className="flex-1 space-y-4 overflow-y-auto rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950"
    >
      {messages.length === 0 && <EmptyState />}
      {messages.map((m) => (
        <MessageBubble key={m.id} message={m} />
      ))}
      {status === "streaming" && <p className="text-xs text-neutral-500">… thinking</p>}
      {status === "error" && (
        <p className="text-xs text-red-600 dark:text-red-400">Connection error — reconnecting…</p>
      )}
    </div>
  );
}

function EmptyState(): React.ReactElement {
  return (
    <div className="space-y-2 py-12 text-center text-sm text-neutral-500">
      <p className="text-base font-medium text-neutral-700 dark:text-neutral-300">
        Ask anything about your data
      </p>
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

function MessageBubble({ message }: { message: UIMessage }): React.ReactElement {
  const isUser = message.role === "user";
  const parts = (message.parts as unknown as UIPart[]) ?? [];
  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div
        className={[
          "max-w-[78ch] rounded-2xl px-4 py-3 text-sm",
          isUser
            ? "bg-neutral-900 text-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
            : "bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100",
        ].join(" ")}
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
  // Unknown part — render as JSON for debugging.
  return (
    <pre className="my-1 overflow-x-auto rounded bg-black/10 p-2 text-[11px] dark:bg-white/10">
      {JSON.stringify(part, null, 2)}
    </pre>
  );
}

/**
 * Reasoning part — the model's internal scratchpad. Rendered as a
 * collapsible "Thinking…" chip with the body indented and dimmed so
 * it reads as side-channel context, not as the answer. While the
 * stream is in flight (state="streaming"), shows a pulsing dot.
 *
 * Defaults to *expanded* when streaming so the user sees activity,
 * collapses to a one-liner once done so the final answer dominates.
 */
function ReasoningPart({ part }: { part: UIPart }): React.ReactElement {
  const text = part.text ?? "";
  const streaming = part.state === "streaming";
  // First sentence (or first 120 chars) for the collapsed preview.
  const preview = (() => {
    const trimmed = text.trim();
    const firstLine = trimmed.split(/\n/, 1)[0] ?? "";
    if (firstLine.length <= 120) return firstLine;
    return firstLine.slice(0, 117) + "…";
  })();

  return (
    <details
      className="group my-1 text-[12px]"
      // Auto-expand only while streaming. Once done, collapse to keep
      // the chat dense and let the final answer dominate.
      open={streaming}
    >
      <summary className="flex cursor-pointer select-none items-center gap-1.5 text-neutral-500 transition hover:text-neutral-700 dark:hover:text-neutral-300">
        <svg
          viewBox="0 0 16 16"
          className="h-3 w-3 shrink-0 transition group-open:rotate-90"
          aria-hidden
        >
          <path d="M5 4l4 4-4 4" stroke="currentColor" strokeWidth="1.4" fill="none" />
        </svg>
        <span className="font-medium uppercase tracking-wide text-[10px]">Thinking</span>
        {streaming && (
          <span
            className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-neutral-400"
            aria-label="thinking"
          />
        )}
        {!streaming && preview && (
          <span className="truncate font-normal italic text-neutral-400 group-open:hidden">
            {preview}
          </span>
        )}
      </summary>
      <div className="mt-1 ml-4 whitespace-pre-wrap border-l-2 border-neutral-200 pl-3 italic leading-relaxed text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
        {text}
      </div>
    </details>
  );
}

/**
 * Tool call rendering. Codemode tool calls (`tool-codemode`) get a
 * special treatment: we extract the user-meaningful `input.code` and
 * `output.result` and show them as code blocks instead of dumping the
 * raw JSON envelope, which is mostly noise.
 */
function ToolPart({ part }: { part: UIPart }): React.ReactElement {
  const rawToolName = part.toolName ?? part.type?.replace(/^tool-/, "") ?? "tool";
  const isCodemode = rawToolName === "codemode";
  const status =
    part.state === "output-available" ? "ok" : part.state === "output-error" ? "err" : "run";

  // Codemode wraps the artifact return in `{ code, result: <artifact> }`.
  // Try to surface an artifact from either shape.
  const artifact = part.output != null ? asArtifactRef(part.output) : null;

  // Extract human-friendly views.
  const codemodeInput = isCodemode ? extractCodemodeCode(part.input) : null;
  const codemodeOutput = isCodemode ? extractCodemodeResult(part.output) : null;

  const summaryLabel = isCodemode ? "ran code" : rawToolName;
  const statusBadgeCls = {
    ok: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
    err: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
    run: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  }[status];
  const statusLabel = { ok: "✓", err: "✗", run: "…" }[status];

  return (
    <div className="my-1">
      {artifact ? <ArtifactViewer ref={artifact} /> : null}
      <details className="group rounded-lg border border-neutral-200 bg-white/60 text-xs dark:border-neutral-800 dark:bg-black/20">
        <summary className="flex cursor-pointer select-none items-center gap-2 px-2.5 py-1.5">
          <span
            className={[
              "inline-flex h-4 w-4 items-center justify-center rounded text-[10px] font-bold leading-none",
              statusBadgeCls,
            ].join(" ")}
            aria-label={status}
          >
            {statusLabel}
          </span>
          <span className="font-medium text-neutral-700 dark:text-neutral-300">{summaryLabel}</span>
          {isCodemode && codemodeInput && (
            <span className="ml-1 truncate font-mono text-[10px] text-neutral-500">
              {summarizeCode(codemodeInput)}
            </span>
          )}
          <svg
            viewBox="0 0 16 16"
            className="ml-auto h-3 w-3 shrink-0 text-neutral-400 transition group-open:rotate-90"
            aria-hidden
          >
            <path d="M5 4l4 4-4 4" stroke="currentColor" strokeWidth="1.4" fill="none" />
          </svg>
        </summary>

        <div className="space-y-2 border-t border-neutral-200 px-2.5 py-2 dark:border-neutral-800">
          {/* Codemode: dedicated code + result blocks */}
          {isCodemode && codemodeInput && (
            <div>
              <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                Code
              </div>
              <pre className="max-h-72 overflow-auto rounded bg-neutral-50 px-2 py-1.5 font-mono text-[11px] leading-snug dark:bg-neutral-950">
                {codemodeInput}
              </pre>
            </div>
          )}
          {isCodemode && codemodeOutput !== null && (
            <div>
              <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                Result
              </div>
              <pre className="max-h-72 overflow-auto rounded bg-neutral-50 px-2 py-1.5 font-mono text-[11px] leading-snug dark:bg-neutral-950">
                {codemodeOutput}
              </pre>
            </div>
          )}

          {/* Non-codemode: original input/output JSON dump */}
          {!isCodemode && part.input != null && (
            <div>
              <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                Input
              </div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-neutral-50 px-2 py-1.5 font-mono text-[11px] leading-snug dark:bg-neutral-950">
                {safeJsonStringify(part.input)}
              </pre>
            </div>
          )}
          {!isCodemode && part.output != null && (
            <div>
              <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                Output
              </div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-neutral-50 px-2 py-1.5 font-mono text-[11px] leading-snug dark:bg-neutral-950">
                {safeJsonStringify(part.output)}
              </pre>
            </div>
          )}
          {part.errorText && <p className="text-red-600 dark:text-red-400">{part.errorText}</p>}
        </div>
      </details>
    </div>
  );
}

/**
 * Codemode input is `{ code: "<source>" }` (already a stringified
 * object in some shapes — handle both). Returns the bare source.
 */
function extractCodemodeCode(input: unknown): string | null {
  if (input == null) return null;
  let obj: unknown = input;
  if (typeof obj === "string") {
    const raw = obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      // Not JSON — assume the LLM already gave us bare source.
      return raw;
    }
  }
  if (typeof obj === "object" && obj !== null) {
    const code = (obj as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

/**
 * Codemode output is `{ code, result: <whatever the function returned> }`.
 * Strip the echoed `code` field and pretty-print just the result.
 */
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

/** One-liner preview of a code blob for the collapsed summary. */
function summarizeCode(code: string): string {
  // Strip the standard `async () => {` wrapper if present, then take
  // the first non-empty line of the body so the user sees what the
  // call actually does (e.g. "await db.introspect()").
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
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded-md px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        aria-haspopup
        aria-expanded={open}
      >
        {members.length} member{members.length === 1 ? "" : "s"}
      </button>
      {open && (
        <div
          role="dialog"
          className="absolute right-0 top-full z-10 mt-1 w-64 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-lg dark:border-neutral-800 dark:bg-neutral-950"
          onMouseLeave={() => setOpen(false)}
        >
          <ul className="max-h-72 overflow-y-auto py-1">
            {members.map((m) => (
              <li key={m.userId} className="flex items-center gap-2 px-3 py-2 text-xs">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: activeIds.has(m.userId) ? "#10b981" : "#a3a3a3" }}
                  aria-label={activeIds.has(m.userId) ? "online" : "offline"}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-neutral-800 dark:text-neutral-100">
                    {m.name || m.email}
                  </span>
                  {m.name && (
                    <span className="block truncate text-[10px] text-neutral-500">{m.email}</span>
                  )}
                </span>
                <span className="text-[10px] uppercase tracking-wide text-neutral-400">
                  {m.role}
                </span>
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
  // Render up to 4 colored circles. Initials and tooltips come from the
  // member directory (display name → first letter of given + family,
  // falling back to email or userId truncation).
  const visible = users.slice(0, 4);
  const overflow = users.length - visible.length;
  const tooltipList = users
    .map((u) => directory.get(u.userId)?.name ?? directory.get(u.userId)?.email ?? u.userId)
    .join(", ");
  return (
    <div className="flex items-center gap-1.5" title={tooltipList}>
      <div className="flex -space-x-1.5">
        {visible.map((u) => {
          const member = directory.get(u.userId);
          const display = member?.name ?? member?.email ?? u.userId;
          const initials = nameToInitials(display);
          return (
            <span
              key={u.userId}
              className="inline-flex h-6 w-6 items-center justify-center rounded-full border-2 border-neutral-50 bg-neutral-200 text-[9px] font-semibold uppercase text-neutral-700 ring-1 ring-neutral-300 dark:border-neutral-950 dark:bg-neutral-700 dark:text-neutral-100 dark:ring-neutral-600"
              style={{ background: idToColor(u.userId) }}
              title={display}
            >
              {initials}
            </span>
          );
        })}
      </div>
      {overflow > 0 && <span className="text-[10px] text-neutral-500">+{overflow}</span>}
    </div>
  );
}

function nameToInitials(name: string): string {
  // Strip emails to local-part, then take first letters of up to two
  // tokens. Single-token names use the first 2 letters.
  const trimmed = name.includes("@") ? name.split("@")[0]! : name;
  const parts = trimmed.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return ((parts[0]?.[0] ?? "") + (parts[parts.length - 1]?.[0] ?? "")).toUpperCase();
  }
  return (parts[0] ?? "").slice(0, 2).toUpperCase() || "?";
}

function idToColor(id: string): string {
  // Deterministic pleasant pastel from the id hash.
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `oklch(0.78 0.09 ${hue})`;
}

function Composer({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (text: string) => void;
}): React.ReactElement {
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
      <textarea
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
        className="min-h-[3rem] flex-1 resize-y rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm shadow-inner focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900"
      />
      <button
        type="submit"
        disabled={disabled || !text.trim()}
        className="self-stretch rounded-lg bg-neutral-900 px-5 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:cursor-not-allowed disabled:bg-neutral-300 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 dark:disabled:bg-neutral-700"
      >
        Send
      </button>
    </form>
  );
}
