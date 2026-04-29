import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ChevronRight, Plus } from "lucide-react";
import { chatsApi, dbProfilesApi } from "~/lib/api";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { ListSkeleton } from "~/components/list-skeleton";

export const Route = createFileRoute("/app/")({
  component: ChatsRoute,
});

function ChatsRoute() {
  const chats = useQuery({
    queryKey: ["chats"],
    queryFn: () => chatsApi.list().then((r) => r.chats),
  });

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Chats</h1>
        <NewChatDialog />
      </header>

      {chats.isLoading && <ListSkeleton rows={4} />}

      {chats.error && (
        <Alert variant="destructive">
          <AlertDescription>{(chats.error as Error).message}</AlertDescription>
        </Alert>
      )}

      {chats.data && chats.data.length === 0 && (
        <div className="rounded-lg border border-dashed border-border bg-card p-10 text-center">
          <p className="text-sm font-medium">No chats yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Create one to start asking questions about your data.
          </p>
        </div>
      )}

      {chats.data && chats.data.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border bg-card">
          {chats.data.map((chat) => (
            <li key={chat.id}>
              <Link
                to="/app/chats/$chatId"
                params={{ chatId: chat.id }}
                className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/40"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{chat.title}</p>
                  <p className="text-xs text-muted-foreground">
                    Updated {new Date(chat.updatedAt).toLocaleString()}
                  </p>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NewChatDialog() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [dbProfileId, setDbProfileId] = useState<string>("none");

  const profiles = useQuery({
    queryKey: ["db-profiles"],
    queryFn: () => dbProfilesApi.list().then((r) => r.profiles),
    enabled: open,
  });

  const create = useMutation({
    mutationFn: () =>
      chatsApi.create({
        title: title.trim() || "Untitled chat",
        dbProfileId: dbProfileId === "none" ? undefined : dbProfileId,
      }),
    onSuccess: ({ chat }) => {
      qc.invalidateQueries({ queryKey: ["chats"] });
      setOpen(false);
      setTitle("");
      setDbProfileId("none");
      navigate({ to: "/app/chats/$chatId", params: { chatId: chat.id } });
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="h-4 w-4" />
          New chat
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New chat</DialogTitle>
          <DialogDescription>
            Pick a database to attach. You can create a chat without one and attach later.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label htmlFor="title">Title</Label>
            <Input
              id="title"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Sales analysis"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="db">Database</Label>
            <Select value={dbProfileId} onValueChange={setDbProfileId}>
              <SelectTrigger id="db">
                <SelectValue placeholder="No database" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No database</SelectItem>
                {profiles.data?.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {create.error && (
            <Alert variant="destructive">
              <AlertDescription>{(create.error as Error).message}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
