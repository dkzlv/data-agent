/**
 * HTTP handlers for `GET /agents/chat-agent/<chatId>/artifacts/...`.
 *
 * Serves artifact bytes out of the agent's Workspace (sql + R2 backed).
 * Authentication is enforced by `authenticateChatRequest` in `index.ts`
 * before the request lands here.
 *
 * Earlier these lived as private methods on the ChatAgent class. They
 * don't read or write any per-turn state, so extracting them keeps
 * the agent class focused on the Think lifecycle.
 */
import type { Workspace } from "@cloudflare/shell";
import { logEvent, truncateMessage } from "@data-agent/shared";

interface ArtifactHost {
  readonly name: string;
  readonly workspace: Workspace;
}

interface ManifestEntry {
  id: string;
  name?: string;
  mime?: string;
  kind?: string;
  size?: number;
  createdAt?: string;
  chartType?: string;
  url?: string;
}

interface Manifest {
  artifacts?: ManifestEntry[];
}

const MANIFEST_PATH = "/artifacts/_manifest.json";

async function loadManifest(host: ArtifactHost): Promise<Manifest | null> {
  const json = await host.workspace.readFile(MANIFEST_PATH);
  if (!json) return null;
  return JSON.parse(json) as Manifest;
}

/**
 * Top-level dispatcher. Path on entry looks like
 * `/agents/chat-agent/<chatId>/artifacts[/<artifactId>]` after the
 * agents SDK has dispatched to the DO. parts =
 * `["agents", "chat-agent", "<chatId>", "artifacts", ...]`.
 */
export async function handleArtifactRequest(
  host: ArtifactHost,
  request: Request
): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[3] !== "artifacts") {
    return new Response("not found", { status: 404 });
  }
  if (parts[4]) {
    return serveArtifact(host, parts[4]);
  }
  return serveArtifactList(host);
}

async function serveArtifactList(host: ArtifactHost): Promise<Response> {
  try {
    const manifest = await loadManifest(host);
    return Response.json({ artifacts: manifest?.artifacts ?? [] });
  } catch (err) {
    logEvent({
      event: "chat.artifact_list_failed",
      level: "warn",
      chatId: host.name,
      error: truncateMessage(err),
    });
    return Response.json({ artifacts: [] });
  }
}

async function serveArtifact(host: ArtifactHost, artifactId: string): Promise<Response> {
  try {
    const manifest = await loadManifest(host);
    if (!manifest) return new Response("not found", { status: 404 });
    const ref = manifest.artifacts?.find((a) => a.id === artifactId);
    if (!ref) return new Response("not found", { status: 404 });
    const body = await host.workspace.readFile(`/artifacts/${ref.id}`);
    if (body == null) return new Response("not found", { status: 404 });
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": ref.mime ?? "application/octet-stream",
        "cache-control": "private, max-age=86400, immutable",
        "x-artifact-id": ref.id,
        ...(ref.name ? { "x-artifact-name": ref.name } : {}),
      },
    });
  } catch (err) {
    logEvent({
      event: "chat.artifact_serve_failed",
      level: "warn",
      chatId: host.name,
      artifactId,
      error: truncateMessage(err),
    });
    return new Response("not found", { status: 404 });
  }
}
