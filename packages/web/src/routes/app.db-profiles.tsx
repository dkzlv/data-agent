import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { dbProfilesApi, type DbProfile } from "~/lib/api";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Badge } from "~/components/ui/badge";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { ListSkeleton } from "~/components/list-skeleton";
import { AppMobileNavTrigger, AppPageScroll } from "~/routes/app";

export const Route = createFileRoute("/app/db-profiles")({
  component: DbProfilesRoute,
});

function DbProfilesRoute() {
  const qc = useQueryClient();
  const profiles = useQuery({
    queryKey: ["db-profiles"],
    queryFn: () => dbProfilesApi.list().then((r) => r.profiles),
  });

  const [showForm, setShowForm] = useState(false);

  return (
    <AppPageScroll>
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <AppMobileNavTrigger />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Database connections</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Read-only Postgres URLs the agent can query.
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant={showForm ? "ghost" : "default"}
          onClick={() => setShowForm(!showForm)}
        >
          {showForm ? (
            "Cancel"
          ) : (
            <>
              <Plus className="h-4 w-4" />
              Add connection
            </>
          )}
        </Button>
      </header>

      {showForm && <NewProfileForm onDone={() => setShowForm(false)} />}

      {profiles.isLoading && <ListSkeleton rows={3} trailing />}

      {profiles.error && (
        <Alert variant="destructive">
          <AlertDescription>{(profiles.error as Error).message}</AlertDescription>
        </Alert>
      )}

      {profiles.data && profiles.data.length === 0 && !showForm && (
        <div className="rounded-lg border border-dashed border-border bg-card p-10 text-center">
          <p className="text-sm font-medium">No connections yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Add one to start chatting with a database.
          </p>
        </div>
      )}

      {profiles.data && profiles.data.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border bg-card">
          {profiles.data.map((p) => (
            <ProfileRow
              key={p.id}
              profile={p}
              onChange={() => qc.invalidateQueries({ queryKey: ["db-profiles"] })}
            />
          ))}
        </ul>
      )}
    </div>
    </AppPageScroll>
  );
}

function statusBadge(status: DbProfile["lastTestedStatus"]) {
  if (status === "ok") return { variant: "success" as const, label: "ok" };
  if (status === "failed") return { variant: "destructive" as const, label: "failed" };
  return { variant: "muted" as const, label: status };
}

function ProfileRow({ profile, onChange }: { profile: DbProfile; onChange: () => void }) {
  const test = useMutation({
    mutationFn: () => dbProfilesApi.test(profile.id),
    onSettled: onChange,
  });
  const remove = useMutation({
    mutationFn: () => dbProfilesApi.remove(profile.id),
    onSuccess: onChange,
  });

  const badge = statusBadge(profile.lastTestedStatus);

  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3 sm:flex-nowrap">
      <div className="min-w-0 flex-1 basis-full sm:basis-auto">
        <p className="truncate font-medium">{profile.name}</p>
        <p className="truncate font-mono text-xs text-muted-foreground">
          {profile.host}:{profile.port}/{profile.database}
        </p>
      </div>
      <Badge variant={badge.variant}>{badge.label}</Badge>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => test.mutate()}
        disabled={test.isPending}
      >
        {test.isPending ? "Testing…" : "Test"}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Delete ${profile.name}`}
        onClick={() => {
          if (confirm(`Delete ${profile.name}?`)) remove.mutate();
        }}
        disabled={remove.isPending}
        className="text-destructive hover:text-destructive"
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </li>
  );
}

function NewProfileForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: "",
    host: "",
    port: 5432,
    database: "",
    user: "",
    password: "",
    sslmode: "require" as const,
  });
  const create = useMutation({
    mutationFn: () => dbProfilesApi.create(form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["db-profiles"] });
      onDone();
    },
  });

  function field(key: keyof typeof form, label: string, type = "text") {
    return (
      <div className="space-y-1.5">
        <Label htmlFor={key}>{label}</Label>
        <Input
          id={key}
          type={type}
          required
          value={form[key] as string | number}
          onChange={(e) =>
            setForm({
              ...form,
              [key]: type === "number" ? Number(e.target.value) : e.target.value,
            })
          }
        />
      </div>
    );
  }

  return (
    <form
      className="space-y-4 rounded-lg border border-border bg-card p-4"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {field("name", "Display name")}
        {field("database", "Database")}
        {field("host", "Host")}
        {field("port", "Port", "number")}
        {field("user", "User")}
        {field("password", "Password", "password")}
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? "Testing connection…" : "Test & save"}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {create.error && (
        <Alert variant="destructive">
          <AlertDescription>{(create.error as Error).message}</AlertDescription>
        </Alert>
      )}
    </form>
  );
}
