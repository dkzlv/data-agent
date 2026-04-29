import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { dbProfilesApi, type DbProfile } from "~/lib/api";

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
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Database connections</h1>
        <button
          type="button"
          onClick={() => setShowForm(!showForm)}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {showForm ? "Cancel" : "Add connection"}
        </button>
      </header>

      {showForm && <NewProfileForm onDone={() => setShowForm(false)} />}

      {profiles.isLoading && <p className="text-sm text-neutral-500">Loading…</p>}
      {profiles.error && (
        <p className="text-sm text-red-600 dark:text-red-400">
          {(profiles.error as Error).message}
        </p>
      )}
      {profiles.data && profiles.data.length === 0 && !showForm && (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          No connections yet. Add one to start chatting with a database.
        </p>
      )}

      <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
        {profiles.data?.map((p) => (
          <ProfileRow
            key={p.id}
            profile={p}
            onChange={() => qc.invalidateQueries({ queryKey: ["db-profiles"] })}
          />
        ))}
      </ul>
    </div>
  );
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

  const status = profile.lastTestedStatus;
  const badge =
    status === "ok"
      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
      : status === "failed"
        ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"
        : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400";

  return (
    <li className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{profile.name}</p>
        <p className="truncate font-mono text-xs text-neutral-500">
          {profile.host}:{profile.port}/{profile.database}
        </p>
      </div>
      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge}`}>{status}</span>
      <button
        type="button"
        onClick={() => test.mutate()}
        disabled={test.isPending}
        className="text-xs text-neutral-600 hover:text-neutral-900 disabled:opacity-50 dark:text-neutral-400 dark:hover:text-neutral-100"
      >
        {test.isPending ? "Testing…" : "Test"}
      </button>
      <button
        type="button"
        onClick={() => {
          if (confirm(`Delete ${profile.name}?`)) remove.mutate();
        }}
        disabled={remove.isPending}
        className="text-xs text-red-600 hover:text-red-700 disabled:opacity-50 dark:text-red-400"
      >
        Delete
      </button>
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
      <label className="block space-y-1">
        <span className="text-sm font-medium">{label}</span>
        <input
          type={type}
          required
          value={form[key] as string | number}
          onChange={(e) =>
            setForm({
              ...form,
              [key]: type === "number" ? Number(e.target.value) : e.target.value,
            })
          }
          className="block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900/10 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-200"
        />
      </label>
    );
  }

  return (
    <form
      className="space-y-4 rounded-lg border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        {field("name", "Display name")}
        {field("database", "Database")}
        {field("host", "Host")}
        {field("port", "Port", "number")}
        {field("user", "User")}
        {field("password", "Password", "password")}
      </div>
      <button
        type="submit"
        disabled={create.isPending}
        className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
      >
        {create.isPending ? "Testing connection…" : "Test & save"}
      </button>
      {create.error && (
        <p className="text-sm text-red-600 dark:text-red-400">{(create.error as Error).message}</p>
      )}
    </form>
  );
}
