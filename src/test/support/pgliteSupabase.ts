// In-process Postgres (PGlite) standing in for Supabase's database, so SQL
// migrations can be executed and their RLS / grants / RPCs asserted in vitest
// without Docker or a network.
//
// What is stubbed (only what the migrations under test touch):
//   * roles anon / authenticated / service_role (NOLOGIN; service_role has
//     BYPASSRLS like on Supabase). Migrations run as the PGlite superuser
//     `postgres`, which owns every object and is what SECURITY DEFINER
//     functions execute as -- same as Supabase, where `postgres` owns them.
//   * Supabase's default privileges in `public` (ALL on tables, sequences and
//     functions to anon/authenticated/service_role), so a migration that forgets
//     to REVOKE is caught by the tests exactly as it would be in production.
//   * schema auth: auth.users(id, email, email_confirmed_at) and auth.uid(),
//     which reads the PostgREST JWT GUCs (request.jwt.claim.sub, falling back to
//     request.jwt.claims ->> 'sub') like the real one.
//
// Deviations from the real migrations (documented, applied in prepareMigration):
//   * `create extension if not exists pgcrypto;` lines are dropped. PGlite can
//     load pgcrypto, but its extension loader breaks under the jsdom test
//     environment, and the migrations only use gen_random_uuid() (core since
//     PG13). The access migrations themselves never use pgcrypto.
//   * `create extension if not exists pg_cron / pg_net;` lines are dropped too:
//     neither exists in PGlite. A test that applies the cron migrations
//     (202607230002, 202607240003, ...) opts into `extensionStubs`, which
//     creates minimal `cron` / `net` schemas instead (see EXTENSION_STUB_SQL):
//     cron.job + cron.schedule/unschedule keep the job table like pg_cron does,
//     and net.http_post records each request in net.stub_requests instead of
//     sending it. Without the stubs, those migrations are simply not applied.
//
// Role switching: asUser / asAnon / asService run the callback in a
// transaction with `SET LOCAL ROLE` + transaction-local JWT GUCs, which is how
// PostgREST executes a request. A thrown error rolls the transaction back
// (deferred constraint triggers fire at COMMIT, inside the helper).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Blob as NodeBlob, File as NodeFile } from "node:buffer";
import { PGlite, type Transaction } from "@electric-sql/pglite";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

/** Migrations the access-control tests need, in apply order. */
export const ACCESS_TEST_MIGRATIONS = [
  "202606110001_create_api_export_integrations.sql",
  "202607090001_create_funnelfox_subscriptions.sql",
  "202607240001_create_funnels_admin.sql",
  "202607240002_add_funnels_funnelfox_id.sql",
  "202607250002_active_subscription_emails_rpc.sql",
  "202607260001_active_subscription_emails_exclude_sandbox.sql",
  "202610050001_phase0_isolation_fixes.sql",
  "202610050002_access_core.sql",
] as const;

/** Migrations the phase-0 isolation test needs (no access core). */
export const PHASE0_TEST_MIGRATIONS = [
  "202607090001_create_funnelfox_subscriptions.sql",
  "202607250002_active_subscription_emails_rpc.sql",
  "202607260001_active_subscription_emails_exclude_sandbox.sql",
  "202610050001_phase0_isolation_fixes.sql",
] as const;

export const SUPABASE_STUB_SQL = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key,
  email text,
  email_confirmed_at timestamptz,
  created_at timestamptz not null default now()
);

create function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;
`;

// Stand-ins for the pg_cron / pg_net surface the migrations call (opt-in, see
// header). Owned by `postgres`, like the real extensions' objects on Supabase.
export const EXTENSION_STUB_SQL = `
create schema cron;

create table cron.job (
  jobid bigserial primary key,
  schedule text not null,
  command text not null,
  username text not null default current_user,
  active boolean not null default true,
  jobname text unique
);

-- pg_cron >= 1.3: scheduling an existing job name replaces it.
create function cron.schedule(job_name text, schedule text, command text)
returns bigint
language sql
as $$
  insert into cron.job (jobname, schedule, command) values ($1, $2, $3)
  on conflict (jobname) do update
    set schedule = excluded.schedule, command = excluded.command, username = current_user
  returning jobid
$$;

-- Like pg_cron, unscheduling an unknown job is an error.
create function cron.unschedule(job_name text)
returns boolean
language plpgsql
as $$
begin
  delete from cron.job j where j.jobname = job_name;
  if not found then
    raise exception 'could not find valid entry for job ''%''', job_name;
  end if;
  return true;
end;
$$;

create schema net;

create table net.stub_requests (
  id bigserial primary key,
  url text not null,
  headers jsonb,
  body jsonb,
  timeout_milliseconds integer,
  created_at timestamptz not null default now()
);

-- Same signature as pg_net's net.http_post; records instead of sending.
create function net.http_post(
  url text,
  body jsonb default '{}'::jsonb,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{"Content-Type": "application/json"}'::jsonb,
  timeout_milliseconds integer default 5000
)
returns bigint
language sql
as $$
  insert into net.stub_requests (url, headers, body, timeout_milliseconds)
  values ($1, $4, $2, $5)
  returning id
$$;
`;

/** Strips statements PGlite cannot run (see header). */
export function prepareMigration(sql: string): string {
  return sql.replace(/^\s*create extension if not exists (pgcrypto|pg_cron|pg_net)\s*;\s*$/gim, "");
}

export function readMigration(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name), "utf8");
}

/**
 * Every migration file in apply order (the timestamp prefix sorts
 * lexicographically). `before` keeps only names sorting before it, e.g. "every
 * migration that precedes the one under test".
 */
export function listMigrations(options: { before?: string } = {}): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .filter((name) => options.before === undefined || name < options.before)
    .sort();
}

async function applyMigrationTo(db: PGlite, name: string): Promise<void> {
  try {
    await db.exec(prepareMigration(readMigration(name)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Applying migration ${name} failed: ${message}`);
  }
}

type GlobalBlobs = { Blob: unknown; File: unknown };

// jsdom replaces the global Blob/File with versions lacking arrayBuffer(); PGlite
// builds and reads its data-dir tarball with them while starting or cloning.
// Swap Node's implementations in for the duration of that work only.
async function withNodeBlobs<T>(work: () => Promise<T>): Promise<T> {
  const globals = globalThis as unknown as GlobalBlobs;
  const original = { Blob: globals.Blob, File: globals.File };
  globals.Blob = NodeBlob;
  globals.File = NodeFile;
  try {
    return await work();
  } finally {
    globals.Blob = original.Blob;
    globals.File = original.File;
  }
}

export type SqlRunner = Pick<Transaction, "query" | "exec">;

export class SupabasePglite {
  constructor(readonly db: PGlite) {}

  /** Runs fn as the `authenticated` role with auth.uid() = userId. */
  asUser<T>(userId: string, fn: (tx: SqlRunner) => Promise<T>): Promise<T> {
    return this.asRole("authenticated", userId, fn);
  }

  /** Runs fn as the `anon` role (no JWT subject). */
  asAnon<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T> {
    return this.asRole("anon", null, fn);
  }

  /** Runs fn as `service_role` (what the Edge service-role client is). */
  asService<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T> {
    return this.asRole("service_role", null, fn);
  }

  /**
   * Runs fn as the superuser/owner (`postgres`), i.e. the SQL editor. With
   * claimUserId the JWT GUCs are set too, so auth.uid()-based definer helpers
   * can be evaluated for that user without needing schema USAGE.
   */
  asPostgres<T>(fn: (tx: SqlRunner) => Promise<T>, claimUserId?: string): Promise<T> {
    return this.db.transaction(async (tx) => {
      if (claimUserId) {
        await tx.query(
          `select set_config('request.jwt.claim.sub', $1, true),
                  set_config('request.jwt.claims', $2, true)`,
          [claimUserId, JSON.stringify({ sub: claimUserId, role: "authenticated" })],
        );
      }
      return fn(tx);
    });
  }

  private asRole<T>(
    role: "anon" | "authenticated" | "service_role",
    userId: string | null,
    fn: (tx: SqlRunner) => Promise<T>,
  ): Promise<T> {
    const claims = JSON.stringify(userId ? { sub: userId, role } : { role });
    return this.db.transaction(async (tx) => {
      await tx.query(
        `select set_config('request.jwt.claim.sub', $1, true),
                set_config('request.jwt.claim.role', $2, true),
                set_config('request.jwt.claims', $3, true)`,
        [userId ?? "", role, claims],
      );
      await tx.exec(`set local role ${role}`);
      return fn(tx);
    });
  }

  /** Inserts an auth.users row (as postgres) and returns its id. */
  async createAuthUser(email: string | null, options: { confirmed?: boolean; id?: string } = {}): Promise<string> {
    const id = options.id ?? randomUUID();
    await this.db.query(
      "insert into auth.users (id, email, email_confirmed_at) values ($1, $2, $3)",
      [id, email, options.confirmed === false ? null : new Date().toISOString()],
    );
    return id;
  }

  /**
   * Applies one more migration (as `postgres`), e.g. after seeding a state the
   * migration must find. The file runs as one implicit transaction, so an
   * error leaves the database unchanged; the message names the migration.
   */
  applyMigration(name: string): Promise<void> {
    return applyMigrationTo(this.db, name);
  }

  /** Independent copy of the current database (fast per-test isolation). */
  async clone(): Promise<SupabasePglite> {
    return withNodeBlobs(async () => {
      const copy = (await (this.db as unknown as { clone(): Promise<PGlite> }).clone()) as PGlite;
      await copy.waitReady;
      return new SupabasePglite(copy);
    });
  }

  close(): Promise<void> {
    return this.db.close();
  }
}

/**
 * Fresh PGlite with the Supabase stubs plus the given migrations applied in
 * order (as `postgres`, like `supabase db push`). `extensionStubs` adds the
 * pg_cron / pg_net stand-ins (EXTENSION_STUB_SQL) for migrations that schedule
 * jobs or post HTTP requests.
 */
export async function createSupabasePglite(options: {
  migrations: readonly string[];
  extensionStubs?: boolean;
}): Promise<SupabasePglite> {
  const db = await withNodeBlobs(async () => {
    const instance = new PGlite();
    await instance.waitReady;
    return instance;
  });
  await db.exec(SUPABASE_STUB_SQL);
  if (options.extensionStubs) await db.exec(EXTENSION_STUB_SQL);
  for (const name of options.migrations) {
    await applyMigrationTo(db, name);
  }
  return new SupabasePglite(db);
}
