/**
 * Tiny API client. Handles credentials + base URL.
 * Throws on non-2xx so TanStack Query can wire its error states.
 */

const API_URL =
  typeof window !== "undefined"
    ? ((window as unknown as { __ENV__?: { API_URL?: string } }).__ENV__?.API_URL ??
      "http://localhost:8787")
    : "http://localhost:8787";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((v, k) => {
        headers[k] = v;
      });
    } else if (Array.isArray(init.headers)) {
      for (const [k, v] of init.headers) headers[k] = v;
    } else {
      Object.assign(headers, init.headers);
    }
  }
  const res = await fetch(`${API_URL}${path}`, {
    credentials: "include",
    ...init,
    headers,
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = (await res.json()) as { error?: string; message?: string };
      msg = j.message ?? j.error ?? msg;
    } catch {
      // body not json
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: "GET" }),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

// ─────────────────────────────────────────────────────────────────
// Typed endpoint shapes
// ─────────────────────────────────────────────────────────────────

export type DbProfile = {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  sslmode: string;
  lastTestedAt: string | null;
  lastTestedStatus: "ok" | "failed" | "never";
  lastTestedError?: string | null;
  createdAt: string;
};

export const dbProfilesApi = {
  list: () => api.get<{ profiles: DbProfile[] }>("/api/db-profiles"),
  create: (input: {
    name: string;
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    sslmode: "disable" | "require" | "verify-ca" | "verify-full";
  }) => api.post<{ profile: DbProfile }>("/api/db-profiles", input),
  test: (id: string) =>
    api.post<{ ok: boolean; error: string | null }>(`/api/db-profiles/${id}/test`, {}),
  remove: (id: string) => api.del<{ ok: true }>(`/api/db-profiles/${id}`),
};
