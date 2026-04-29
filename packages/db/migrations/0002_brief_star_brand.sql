CREATE TYPE "public"."tenant_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."db_profile_kind" AS ENUM('postgres');--> statement-breakpoint
CREATE TYPE "public"."db_profile_test_status" AS ENUM('ok', 'failed', 'never');--> statement-breakpoint
CREATE TYPE "public"."chat_member_role" AS ENUM('owner', 'participant');--> statement-breakpoint
CREATE TABLE "tenant" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_member" (
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "tenant_role" DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_member_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "db_profile" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"created_by" text NOT NULL,
	"kind" "db_profile_kind" DEFAULT 'postgres' NOT NULL,
	"host" text NOT NULL,
	"port" integer DEFAULT 5432 NOT NULL,
	"database" text NOT NULL,
	"sslmode" text DEFAULT 'require' NOT NULL,
	"encrypted_credentials" "bytea" NOT NULL,
	"encrypted_dek" "bytea" NOT NULL,
	"encryption_key_version" integer DEFAULT 1 NOT NULL,
	"last_tested_at" timestamp with time zone,
	"last_tested_status" "db_profile_test_status" DEFAULT 'never' NOT NULL,
	"last_tested_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chat" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"db_profile_id" text,
	"title" text DEFAULT 'Untitled chat' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chat_member" (
	"chat_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "chat_member_role" DEFAULT 'participant' NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_member_chat_id_user_id_pk" PRIMARY KEY("chat_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text,
	"chat_id" text,
	"action" text NOT NULL,
	"target" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_member" ADD CONSTRAINT "tenant_member_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_member" ADD CONSTRAINT "tenant_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_profile" ADD CONSTRAINT "db_profile_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_profile" ADD CONSTRAINT "db_profile_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat" ADD CONSTRAINT "chat_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat" ADD CONSTRAINT "chat_db_profile_id_db_profile_id_fk" FOREIGN KEY ("db_profile_id") REFERENCES "public"."db_profile"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat" ADD CONSTRAINT "chat_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_member" ADD CONSTRAINT "chat_member_chat_id_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_member" ADD CONSTRAINT "chat_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_chat_id_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chat"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tenant_owner_idx" ON "tenant" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "tenant_member_user_idx" ON "tenant_member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "db_profile_tenant_idx" ON "db_profile" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "db_profile_alive_idx" ON "db_profile" USING btree ("tenant_id","deleted_at");--> statement-breakpoint
CREATE INDEX "chat_tenant_created_idx" ON "chat" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_alive_idx" ON "chat" USING btree ("tenant_id","archived_at");--> statement-breakpoint
CREATE INDEX "chat_member_user_idx" ON "chat_member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_log_tenant_created_idx" ON "audit_log" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_chat_idx" ON "audit_log" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("tenant_id","action");