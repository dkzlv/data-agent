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

interface ChatRoomProps {
  chatId: string;
  /** Optional title shown above the message list. */
  title?: string;
}

export function ChatRoom({ chatId, title }: ChatRoomProps): React.ReactElement {
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
          <PresenceBadges users={presence} />
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

function ToolPart({ part }: { part: UIPart }): React.ReactElement {
  const toolName = part.toolName ?? part.type?.replace(/^tool-/, "") ?? "tool";
  const status =
    part.state === "output-available" ? "✓" : part.state === "output-error" ? "✗" : "…";

  // Surface artifacts inline when the tool result carries one.
  const artifact = part.output != null ? asArtifactRef(part.output) : null;

  return (
    <div className="my-1">
      {artifact ? <ArtifactViewer ref={artifact} /> : null}
      <details className="rounded border border-neutral-300 bg-white/40 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-black/20">
        <summary className="cursor-pointer select-none font-mono">
          {status} {toolName}
        </summary>
        {part.input != null && (
          <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-snug">
            {safeJsonStringify(part.input)}
          </pre>
        )}
        {part.output != null && (
          <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-neutral-300 pt-1 text-[10px] leading-snug dark:border-neutral-700">
            {safeJsonStringify(part.output)}
          </pre>
        )}
        {part.errorText && <p className="mt-1 text-red-600 dark:text-red-400">{part.errorText}</p>}
      </details>
    </div>
  );
}

function safeJsonStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function PresenceBadges({ users }: { users: { userId: string; joinedAt: number }[] }) {
  if (users.length <= 1) return null;
  // Render up to 4 colored circles with initials. We don't have user
  // display names on the wire yet (only ids); use the first 2 chars
  // of the id as a placeholder. dea3ff hooks in proper member lookup.
  const visible = users.slice(0, 4);
  const overflow = users.length - visible.length;
  return (
    <div className="flex items-center gap-1.5" title={`${users.length} active`}>
      <div className="flex -space-x-1.5">
        {visible.map((u) => (
          <span
            key={u.userId}
            className="inline-flex h-6 w-6 items-center justify-center rounded-full border-2 border-neutral-50 bg-neutral-200 text-[9px] font-semibold uppercase text-neutral-700 ring-1 ring-neutral-300 dark:border-neutral-950 dark:bg-neutral-700 dark:text-neutral-100 dark:ring-neutral-600"
            style={{ background: idToColor(u.userId) }}
            title={u.userId}
          >
            {u.userId.slice(0, 2)}
          </span>
        ))}
      </div>
      {overflow > 0 && <span className="text-[10px] text-neutral-500">+{overflow}</span>}
    </div>
  );
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
