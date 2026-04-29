CREATE TYPE "public"."memory_kind" AS ENUM('schema_semantic', 'business_def', 'user_pref', 'query_pattern_good', 'query_pattern_bad', 'entity', 'chat_summary');--> statement-breakpoint
CREATE TABLE "memory_fact" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"db_profile_id" text NOT NULL,
	"kind" "memory_kind" NOT NULL,
	"content" text NOT NULL,
	"payload" jsonb,
	"source_chat_id" text,
	"source_turn_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content_hash" text NOT NULL,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "memory_fact" ADD CONSTRAINT "memory_fact_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_fact" ADD CONSTRAINT "memory_fact_db_profile_id_db_profile_id_fk" FOREIGN KEY ("db_profile_id") REFERENCES "public"."db_profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_fact" ADD CONSTRAINT "memory_fact_source_chat_id_chat_id_fk" FOREIGN KEY ("source_chat_id") REFERENCES "public"."chat"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_fact" ADD CONSTRAINT "memory_fact_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_fact_profile_idx" ON "memory_fact" USING btree ("db_profile_id","deleted_at");--> statement-breakpoint
CREATE INDEX "memory_fact_tenant_idx" ON "memory_fact" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_fact_dedupe_idx" ON "memory_fact" USING btree ("db_profile_id","content_hash");