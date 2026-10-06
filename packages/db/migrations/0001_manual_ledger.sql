CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"original_filename" text,
	"mime_type" text,
	"byte_size" integer,
	"sha256" text,
	"storage_key" text,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"page_count" integer,
	"failure_reason" text,
	"draft_json" jsonb,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp with time zone,
	CONSTRAINT "documents_user_sha256_unique" UNIQUE("user_id","sha256")
);
--> statement-breakpoint
CREATE TABLE "manual_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"document_id" uuid,
	"name" text NOT NULL,
	"official_name" text,
	"mask" text,
	"type" text NOT NULL,
	"subtype" text,
	"institution_name" text,
	"iso_currency_code" text DEFAULT 'USD' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "manual_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"document_id" uuid,
	"as_of_date" date NOT NULL,
	"current_cents" bigint NOT NULL,
	"available_cents" bigint,
	"limit_cents" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manual_balances_account_date_unique" UNIQUE("account_id","as_of_date")
);
--> statement-breakpoint
CREATE TABLE "manual_holdings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"security_id" uuid NOT NULL,
	"document_id" uuid,
	"quantity" numeric NOT NULL,
	"cost_basis_cents" bigint,
	"value_cents" bigint NOT NULL,
	"as_of_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manual_holdings_account_security_date_unique" UNIQUE("account_id","security_id","as_of_date")
);
--> statement-breakpoint
CREATE TABLE "manual_securities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text,
	"ticker_symbol" text,
	"type" text,
	"close_price_cents" bigint,
	"is_cash_equivalent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "manual_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"document_id" uuid,
	"date" date NOT NULL,
	"amount_cents" bigint NOT NULL,
	"name" text NOT NULL,
	"merchant_name" text,
	"category_primary" text,
	"category_detailed" text,
	"external_id" text,
	"iso_currency_code" text DEFAULT 'USD' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manual_transactions_dedupe_unique" UNIQUE("account_id","date","amount_cents","name")
);
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_accounts" ADD CONSTRAINT "manual_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_accounts" ADD CONSTRAINT "manual_accounts_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_balances" ADD CONSTRAINT "manual_balances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_balances" ADD CONSTRAINT "manual_balances_account_id_manual_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."manual_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_balances" ADD CONSTRAINT "manual_balances_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_holdings" ADD CONSTRAINT "manual_holdings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_holdings" ADD CONSTRAINT "manual_holdings_account_id_manual_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."manual_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_holdings" ADD CONSTRAINT "manual_holdings_security_id_manual_securities_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."manual_securities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_holdings" ADD CONSTRAINT "manual_holdings_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_securities" ADD CONSTRAINT "manual_securities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_transactions" ADD CONSTRAINT "manual_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_transactions" ADD CONSTRAINT "manual_transactions_account_id_manual_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."manual_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_transactions" ADD CONSTRAINT "manual_transactions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_user_id_idx" ON "documents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "manual_accounts_user_id_idx" ON "manual_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "manual_balances_user_id_idx" ON "manual_balances" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "manual_holdings_user_id_idx" ON "manual_holdings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "manual_securities_user_id_idx" ON "manual_securities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "manual_transactions_user_date_idx" ON "manual_transactions" USING btree ("user_id","date");