import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { authClient } from "~/lib/auth-client";

export const Route = createFileRoute("/login")({
  component: LoginRoute,
});

type Status = "idle" | "sending" | "sent" | "error";

function LoginRoute() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setStatus("sending");
    setErrorMsg("");
    try {
      // The magic-link verify handler lives on the api-gateway and
      // redirects to whatever URL we hand it as `callbackURL`. We need
      // an *absolute* URL pointing back at the web app — a relative
      // path resolves against the api-gateway's baseURL and ends up at
      // `data-agent-api-gateway.dkzlv.workers.dev/app`, which 404s
      // because the web routes live on a different worker.
      const callbackURL = typeof window !== "undefined" ? `${window.location.origin}/app` : "/app";
      const res = await authClient.signIn.magicLink({
        email: email.trim(),
        callbackURL,
      });
      if (res.error) {
        setStatus("error");
        setErrorMsg(res.error.message ?? "Something went wrong. Try again.");
        return;
      }
      setStatus("sent");
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-8 px-6">
      <header className="space-y-2">
        <p className="font-mono text-xs uppercase tracking-widest text-neutral-500">
          <Link to="/" className="hover:underline">
            ← data-agent
          </Link>
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Sign in with email</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          We'll send a one-time link. No password.
        </p>
      </header>

      {status === "sent" ? (
        <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900">
          <p className="font-medium">Check your inbox.</p>
          <p className="mt-1 text-neutral-600 dark:text-neutral-400">
            We sent a sign-in link to <span className="font-mono">{email}</span>. It expires in 10
            minutes.
          </p>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="email" className="block text-sm font-medium">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoFocus
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900/10 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-200 dark:focus:ring-neutral-200/10"
              disabled={status === "sending"}
            />
          </div>
          <button
            type="submit"
            disabled={status === "sending" || !email}
            className="w-full rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            {status === "sending" ? "Sending…" : "Send sign-in link"}
          </button>
          {status === "error" && (
            <p className="text-sm text-red-600 dark:text-red-400">{errorMsg}</p>
          )}
        </form>
      )}
    </main>
  );
}
