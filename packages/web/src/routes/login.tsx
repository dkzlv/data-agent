import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { authClient } from "~/lib/auth-client";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";

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
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-8 px-6 py-12">
      <header className="space-y-2">
        <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
          <Link to="/" className="hover:underline">
            ← data-agent
          </Link>
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Sign in with email</h1>
        <p className="text-sm text-muted-foreground">We'll send a one-time link. No password.</p>
      </header>

      {status === "sent" ? (
        <Alert>
          <AlertTitle>Check your inbox</AlertTitle>
          <AlertDescription>
            We sent a sign-in link to <span className="font-mono">{email}</span>. It expires in 10
            minutes.
          </AlertDescription>
        </Alert>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoFocus
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              disabled={status === "sending"}
            />
          </div>
          <Button type="submit" disabled={status === "sending" || !email} className="w-full">
            {status === "sending" ? "Sending…" : "Send sign-in link"}
          </Button>
          {status === "error" && (
            <Alert variant="destructive">
              <AlertDescription>{errorMsg}</AlertDescription>
            </Alert>
          )}
        </form>
      )}
    </main>
  );
}
