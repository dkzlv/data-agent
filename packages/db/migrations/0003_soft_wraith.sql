ALTER TABLE "chat" ALTER COLUMN "title" SET DEFAULT 'New chat';--> statement-breakpoint
ALTER TABLE "chat" ADD COLUMN "title_auto_generated" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- Backfill: every chat created before this migration was titled by a
-- human (the manual "Title" input on /app), so we treat them as
-- user-owned and the auto-summarizer leaves them alone.
UPDATE "chat" SET "title_auto_generated" = false;