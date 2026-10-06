-- Access control Phase 2: funnel-scoped reads for restricted members (media
-- buyers). Implementation spec §2.1 (plan sharded-painting-axolotl §5, D3).
--
-- Apply order (spec §8): this migration FIRST, then the scope-aware Edge
-- deploy, then 202610060002 (cron), then the frontend. It is safe on its own:
--   * resolve_access / my_access / allowed_paths return the same paths as before
--     for every registry row already in canonical form (the seed below grants
--     each funnel exactly its own canonical path);
--   * the registry RLS narrowing only hits restricted (selected / none scope)
--     members, who get 403 on every Edge function until the Phase-2 deploy;
--   * the new snapshot-state columns are nullable and nothing reads them yet.
-- Its first statement refuses to run before 202610050003 (the RLS lockdown).
-- Apply it as ONE transaction (supabase db push does) so a failed guard or
-- fail-closed check aborts the whole file.
--
-- What it does:
--   1. app.canonical_campaign_path(): SQL mirror of rule A (palmerTransform.ts
--      normalizeCampaignPath, non-URL branch plus scheme/host strip). Used on
--      registry values only; '' / 'unknown' / >200 chars => null (unscopable).
--   2. public.funnel_paths: funnels.id -> canonical campaign paths, statuses
--      proposed | active | retired | revoked. ONLY active and retired grant
--      access (a retired path keeps showing its old cohorts). A path is granted
--      to at most one funnel. Rows are never deleted; funnel_id / path / source
--      are immutable.
--   3. Seed: every funnel's own canonical path becomes active, except canonical
--      collisions (proposed, for an admin to settle); the known FunnelFox
--      renames of 202607240002 become proposals.
--   4. public.funnels: funnel_path is canonicalized on write and every path
--      change is mirrored into funnel_paths (new path active, old one retired).
--   5. access_version: bumped for the members holding a funnel whenever the set
--      of granted (active ∪ retired) paths of that funnel changes. Replaces the
--      funnels.funnel_path trigger of 202610050002.
--   6. Resolver: resolve_access / my_access / allowed_paths read funnel_paths.
--   7. Registry RLS: funnels / funnel_tags / tags / funnel_paths reads are
--      scoped to the member's funnels (scope all sees everything, including
--      proposed and revoked paths). Writes keep the 202610050003 rule.
--   8. RPCs (service_role, called by the Edge `access` function):
--      access_attach_funnel_path / access_set_funnel_path_status, audited.
--   9. Cohort snapshot state: active_* columns describing the ACTIVE snapshot
--      (claiming or failing a build overwrites status and diagnostics, so the
--      Edge freshness gate cannot read those), plus observe / set RPCs.
--
-- Error contract (as 202610050002): SQLSTATE P0001, message "<code>: <detail>"
-- with code invalid | not_found | conflict | permission_denied.


-- ---------------------------------------------------------------------------
-- §0 Guard: 202610050003 must already be applied
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_policy p
    where p.polrelid = 'public.funnels'::regclass
      and p.polname = 'lockdown_active_member'
      and not p.polpermissive
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'access_phase2_scope: 202610050003_access_rls_lockdown.sql is not applied (public.funnels has no lockdown_active_member policy)',
      hint = 'Apply 202610050003 first (plan §26 step 8). The registry scope below only narrows what the lockdown already restricts.';
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- §1 Canonicalizer (rule A)
-- ---------------------------------------------------------------------------

-- lower + trim, strip an http(s) scheme and host, cut at '?' / '#', trim '/',
-- runs of anything but [a-z0-9] -> '-', trim '-'. Percent-decoding and the
-- other URL normalizations of `new URL()` are not mirrored: registry values
-- are paths, not URLs.
create or replace function app.canonical_campaign_path(p_raw text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when v.p = '' or v.p = 'unknown' or char_length(v.p) > 200 then null else v.p end
  from (
    select btrim(regexp_replace(btrim(split_part(split_part(
             regexp_replace(lower(btrim(coalesce(p_raw, ''), E' \t\r\n')), '^https?://[^/]+', ''),
             '?', 1), '#', 1), '/'), '[^a-z0-9]+', '-', 'g'), '-') as p
  ) v
$$;


-- ---------------------------------------------------------------------------
-- §2 public.funnel_paths
-- ---------------------------------------------------------------------------

create table public.funnel_paths (
  id bigint generated always as identity primary key,
  funnel_id uuid not null references public.funnels(id) on delete restrict,
  path_canonical text not null,
  status text not null,
  source text not null,
  funnelfox_funnel_id text,
  note text not null default '',
  created_by uuid,
  created_at timestamptz not null default now(),
  confirmed_by uuid,
  confirmed_at timestamptz,
  retired_at timestamptz,
  revoked_by uuid,
  revoked_at timestamptz,
  updated_at timestamptz not null default now(),

  constraint funnel_paths_path_canonical_check check (
    path_canonical ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and path_canonical <> 'unknown' and char_length(path_canonical) <= 200
  ),
  constraint funnel_paths_status_check check (status in ('proposed', 'active', 'retired', 'revoked')),
  constraint funnel_paths_source_check check (source in ('registry_seed', 'registry', 'funnelfox_alias_seed', 'admin_alias')),
  constraint funnel_paths_confirmed_check check (status not in ('active', 'retired') or confirmed_at is not null),
  constraint funnel_paths_note_check check (char_length(note) <= 500)
);

-- One row per (funnel, path); a GRANTED path belongs to one funnel only.
-- Proposals may compete for the same path.
create unique index funnel_paths_funnel_path_uidx on public.funnel_paths (funnel_id, path_canonical);
create unique index funnel_paths_granted_path_uidx on public.funnel_paths (path_canonical)
  where status in ('active', 'retired');
create index funnel_paths_funnel_granted_idx on public.funnel_paths (funnel_id)
  where status in ('active', 'retired');

comment on table public.funnel_paths is
  'Canonical campaign paths of a funnel (grant expansion). active and retired grant access; proposed and revoked do not.';


-- ---------------------------------------------------------------------------
-- §3 Guard triggers: never deleted, identity immutable, no way back to proposed
-- ---------------------------------------------------------------------------

create or replace function app.funnel_paths_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    perform app.deny('invalid', 'funnel_paths rows are never deleted; revoke the path instead');
  end if;
  if new.id is distinct from old.id
    or new.funnel_id is distinct from old.funnel_id
    or new.path_canonical is distinct from old.path_canonical
    or new.source is distinct from old.source
    or new.funnelfox_funnel_id is distinct from old.funnelfox_funnel_id
    or new.created_at is distinct from old.created_at
    or new.created_by is distinct from old.created_by then
    perform app.deny('invalid', 'funnel_paths funnel_id, path_canonical, source, funnelfox_funnel_id and created_* are immutable');
  end if;
  if new.status = 'proposed' and old.status <> 'proposed' then
    perform app.deny('invalid', 'a funnel path cannot go back to proposed');
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger funnel_paths_guard before update or delete on public.funnel_paths
for each row execute function app.funnel_paths_guard();

-- TRUNCATE skips row triggers.
create trigger funnel_paths_block_truncate before truncate on public.funnel_paths
for each statement execute function app.block_truncate();


-- ---------------------------------------------------------------------------
-- §4 Seed (before the access_version trigger exists: seeding bumps nobody)
-- ---------------------------------------------------------------------------

do $$
declare
  v_ws uuid;
  v_active integer := 0;
  v_proposed integer := 0;
  v_skipped integer := 0;
  v_inserted integer;
  v_candidates integer;
  v_unscopable text;
begin
  -- Each funnel's own path. A canonical value shared by several registry rows
  -- (e.g. 'a_b' and 'a-b') cannot be granted to all of them: every one becomes
  -- a proposal, and an admin confirms one (or edits the others' paths).
  with c as (
    select f.id, app.canonical_campaign_path(f.funnel_path) as path, f.funnelfox_funnel_id
    from public.funnels f
  ),
  shared as (
    select c.path from c where c.path is not null group by c.path having count(*) > 1
  ),
  inserted as (
    insert into public.funnel_paths (funnel_id, path_canonical, status, source, funnelfox_funnel_id, note, confirmed_at)
    select
      c.id,
      c.path,
      case when s.path is null then 'active' else 'proposed' end,
      'registry_seed',
      c.funnelfox_funnel_id,
      case when s.path is null then '' else 'canonical collision: several registry rows share this path' end,
      case when s.path is null then now() end
    from c
    left join shared s on s.path = c.path
    where c.path is not null
    returning status
  )
  select count(*) filter (where status = 'active'), count(*) filter (where status = 'proposed')
    into v_active, v_proposed
  from inserted;

  -- No canonical form ('', 'unknown', no [a-z0-9] at all): no row. The data of
  -- such a funnel stays visible with scope all only.
  select string_agg(f.id::text, ', ' order by f.id), count(*)
    into v_unscopable, v_skipped
  from public.funnels f
  where app.canonical_campaign_path(f.funnel_path) is null;
  if v_skipped > 0 then
    raise notice 'access_phase2_scope: % funnel(s) have no canonical campaign path and get no funnel_paths row: %',
      v_skipped, v_unscopable;
  end if;

  -- The FunnelFox renames of 202607240002 (one funnel id, two campaign paths)
  -- become proposals on the funnel holding that FunnelFox id. Skipped when the
  -- path is already granted (to any funnel) or the row already exists.
  with pairs (funnelfox_funnel_id, path) as (
    values
      ('01KMN4TNEV27GPXXFFXJRYXM2D', 'starseed-reading-sp'),
      ('01KMN4TNEV27GPXXFFXJRYXM2D', 'starseed-reading-spain'),
      ('01KTKBKEHTK6WCNV9TVDJWQHBS', 'soulmate-1-tariff-month-veb'),
      ('01KTKBKEHTK6WCNV9TVDJWQHBS', 'soulmate-sketch'),
      ('01KTP2K149289BWYH0924N0X3D', 'astroline-jp'),
      ('01KTP2K149289BWYH0924N0X3D', 'palm-reading')
  ),
  candidates as (
    select f.id as funnel_id, p.path, p.funnelfox_funnel_id
    from pairs p
    join public.funnels f on f.funnelfox_funnel_id = p.funnelfox_funnel_id
  ),
  inserted as (
    insert into public.funnel_paths (funnel_id, path_canonical, status, source, funnelfox_funnel_id, note)
    select c.funnel_id, c.path, 'proposed', 'funnelfox_alias_seed', c.funnelfox_funnel_id,
      'FunnelFox funnel ' || c.funnelfox_funnel_id || ' has also run under this path (202607240002)'
    from candidates c
    where not exists (
        select 1 from public.funnel_paths fp
        where fp.path_canonical = c.path and fp.status in ('active', 'retired')
      )
      and not exists (
        select 1 from public.funnel_paths fp
        where fp.funnel_id = c.funnel_id and fp.path_canonical = c.path
      )
    returning 1
  )
  select (select count(*) from inserted), (select count(*) from candidates)
    into v_inserted, v_candidates;
  v_proposed := v_proposed + v_inserted;
  v_skipped := v_skipped + (v_candidates - v_inserted);

  -- skipped = funnels without a canonical path + alias proposals not inserted.
  select w.id into v_ws from public.workspaces w limit 1;
  if v_ws is not null then
    perform app.write_audit(
      v_ws, 'registry.paths_seeded', 'system', null, null, 'registry', null, 'success', null, null, null,
      jsonb_build_object('active', v_active, 'proposed', v_proposed, 'skipped', v_skipped)
    );
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- §5 public.funnels: canonical funnel_path, mirrored into funnel_paths
-- ---------------------------------------------------------------------------

-- Rows written before this migration are not rewritten; a write that changes
-- funnel_path stores its canonical form or is refused.
create or replace function app.funnels_canonicalize_path()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_path text;
begin
  if tg_op = 'UPDATE' and new.funnel_path is not distinct from old.funnel_path then
    return new;
  end if;
  v_path := app.canonical_campaign_path(new.funnel_path);
  if v_path is null then
    perform app.deny('invalid', 'funnel_path has no canonical campaign_path form');
  end if;
  new.funnel_path := v_path;
  return new;
end;
$$;

-- The new canonical path becomes (or becomes again) this funnel's active path;
-- on a re-path the previous one is retired, so the members keep the cohorts
-- acquired under it (a mistaken path therefore stays granted, as retired, until
-- it is revoked under Admin -> Funnel coverage). A path granted to another
-- funnel refuses the whole write, and so does a path an admin REVOKED from this
-- funnel: an edit of funnel_path never silently re-grants it (paths.attach does,
-- with its confirmation).
create or replace function app.funnels_sync_paths()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new text := app.canonical_campaign_path(new.funnel_path);
  v_old text;
  v_user uuid := auth.uid();
  v_ws uuid;
begin
  if tg_op = 'UPDATE' then
    v_old := app.canonical_campaign_path(old.funnel_path);
    if v_old is not distinct from v_new then
      return null;
    end if;
  end if;
  if v_new is null then
    return null; -- unreachable: funnels_canonicalize_path refuses it
  end if;
  if exists (
    select 1 from public.funnel_paths fp
    where fp.funnel_id = new.id and fp.path_canonical = v_new and fp.status = 'revoked'
  ) then
    perform app.deny('conflict', format(
      'path %s was revoked from this funnel; attach it again under Admin -> Funnel coverage first', v_new));
  end if;

  begin
    insert into public.funnel_paths as fp (
      funnel_id, path_canonical, status, source, funnelfox_funnel_id, created_by, confirmed_by, confirmed_at
    ) values (
      new.id, v_new, 'active', 'registry', new.funnelfox_funnel_id, v_user, v_user, now()
    )
    on conflict (funnel_id, path_canonical) do update
      set status = 'active', confirmed_by = v_user, confirmed_at = now(),
          retired_at = null, revoked_by = null, revoked_at = null
      where fp.status <> 'active';
  exception when unique_violation then
    perform app.deny('conflict', format('path %s already belongs to another funnel', v_new));
  end;

  if tg_op = 'UPDATE' and v_old is not null then
    update public.funnel_paths fp
    set status = 'retired', retired_at = now()
    where fp.funnel_id = new.id and fp.path_canonical = v_old and fp.status = 'active';
  end if;

  select w.id into v_ws from public.workspaces w limit 1;
  if v_ws is not null then
    perform app.write_audit(
      v_ws,
      case when tg_op = 'INSERT' then 'registry.path_registered' else 'registry.path_repathed' end,
      case when v_user is null then 'system' else 'user' end,
      v_user,
      app.current_member(),
      'funnel', new.id::text, 'success', null,
      case when tg_op = 'UPDATE' then jsonb_build_object('path', v_old) end,
      jsonb_build_object('path', v_new),
      -- A re-path changes what the funnel's members see (the RPCs report the same count).
      case when tg_op = 'UPDATE'
        then jsonb_build_object('affected_members', app.funnel_path_affected_members(new.id))
        else '{}'::jsonb
      end
    );
  end if;
  return null;
end;
$$;

create trigger funnels_canonicalize_path
before insert or update of funnel_path on public.funnels
for each row execute function app.funnels_canonicalize_path();

create trigger funnels_sync_paths
after insert or update of funnel_path on public.funnels
for each row execute function app.funnels_sync_paths();

-- Superseded by the funnel_paths trigger below (a re-path changes funnel_paths,
-- which bumps). app.funnel_path_bump_members() stays: the rollback re-creates
-- this trigger, and the static lints require every created function to exist.
drop trigger funnels_bump_member_access_version on public.funnels;


-- ---------------------------------------------------------------------------
-- §6 access_version: bump when a funnel's granted path set changes
-- ---------------------------------------------------------------------------

-- active <-> retired and changes of proposed / revoked rows only do not change
-- the granted set, so they do not bump; a re-path bumps exactly once.
create or replace function app.funnel_paths_bump_members()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_funnel uuid := coalesce(new.funnel_id, old.funnel_id);
  v_changed boolean;
begin
  v_changed := case tg_op
    when 'INSERT' then new.status in ('active', 'retired')
    else (old.status in ('active', 'retired')) is distinct from (new.status in ('active', 'retired'))
  end;
  if v_changed then
    update public.workspace_members m
    set access_version = m.access_version + 1
    where m.id in (
      select v.member_id from public.member_scope_values v
      where v.dimension = 'funnel' and v.funnel_id = v_funnel
    );
  end if;
  return null;
end;
$$;

create trigger funnel_paths_bump_member_access_version
after insert or update of status on public.funnel_paths
for each row execute function app.funnel_paths_bump_members();


-- ---------------------------------------------------------------------------
-- §7 Resolver: paths come from funnel_paths (active ∪ retired)
-- ---------------------------------------------------------------------------

create or replace function app.funnel_scope_paths(p_funnel_ids uuid[])
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct fp.path_canonical order by fp.path_canonical), '{}'::text[])
  from public.funnel_paths fp
  where fp.funnel_id = any (coalesce(p_funnel_ids, '{}'::uuid[]))
    and fp.status in ('active', 'retired')
$$;

-- 202610050002 body; only the 'selected' path expansion changed.
create or replace function app.resolve_access_core(p_user_id uuid, p_include_data_key boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ws public.workspaces%rowtype;
  v_member public.workspace_members%rowtype;
  v_role public.access_roles%rowtype;
  v_mode text;
  v_funnel_ids uuid[] := '{}'::uuid[];
  v_paths text[] := '{}'::text[];
  v_email text;
  v_partition text;
  v_result jsonb;
begin
  if p_user_id is null then
    return jsonb_build_object('status', 'no_membership', 'user_id', null);
  end if;

  select * into v_ws from public.workspaces limit 1;
  if not found then
    return jsonb_build_object('status', 'no_workspace', 'user_id', p_user_id, 'workspace_id', null);
  end if;

  select * into v_member
  from public.workspace_members m
  where m.user_id = p_user_id and m.workspace_id = v_ws.id;
  if not found then
    return jsonb_build_object('status', 'no_membership', 'user_id', p_user_id, 'workspace_id', v_ws.id);
  end if;

  if v_member.status <> 'active' then
    return jsonb_build_object('status', 'disabled', 'user_id', p_user_id, 'workspace_id', v_ws.id);
  end if;

  select * into v_role from public.access_roles r where r.id = v_member.role_id;
  if not found then
    -- Impossible under the FK; fail closed (Edge maps an RPC error to 503).
    raise exception 'access role % missing for member %', v_member.role_id, v_member.id;
  end if;

  v_mode := app.member_scope_mode(v_member.id);
  if v_mode = 'selected' then
    v_funnel_ids := app.member_funnel_ids(v_member.id);
    v_paths := app.funnel_scope_paths(v_funnel_ids);
  end if;

  select u.email into v_email from auth.users u where u.id = p_user_id;

  v_partition := encode(sha256(convert_to(concat_ws('|',
    v_ws.id::text,
    p_user_id::text,
    v_member.access_version::text,
    v_mode,
    array_to_string(v_funnel_ids, ',')
  ), 'UTF8')), 'hex');

  v_result := jsonb_build_object(
    'status', 'ok',
    'workspace_id', v_ws.id,
    'member_id', v_member.id,
    'user_id', p_user_id,
    'email', coalesce(v_email, nullif(v_member.email_snapshot, '')),
    'display_name', nullif(v_member.display_name, ''),
    'is_data_owner', v_member.is_data_owner,
    'raw_access', p_user_id = v_ws.data_key,
    'role', jsonb_build_object(
      'id', v_role.id,
      'key', v_role.key,
      'name', v_role.name,
      'is_owner', v_role.is_owner,
      'permissions', to_jsonb(v_role.permissions)
    ),
    'funnel_scope', jsonb_build_object(
      'mode', v_mode,
      'funnel_ids', to_jsonb(v_funnel_ids),
      'paths', to_jsonb(v_paths)
    ),
    'access_version', v_member.access_version::text,
    'partition', v_partition
  );

  if p_include_data_key then
    v_result := v_result || jsonb_build_object('data_key', v_ws.data_key);
  end if;

  return v_result;
end;
$$;

-- 202610050002 body; the 'selected' branch reads funnel_paths.
create or replace function app.allowed_paths()
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select case sr.mode
      when 'all' then array['*']::text[]
      when 'selected' then app.funnel_scope_paths(app.member_funnel_ids(m.id))
      else '{}'::text[]
    end
    from public.workspace_members m
    left join public.member_scope_rules sr on sr.member_id = m.id and sr.dimension = 'funnel'
    where m.user_id = (select auth.uid()) and m.status = 'active'
  ), '{}'::text[])
$$;


-- ---------------------------------------------------------------------------
-- §8 Registry RLS: reads scoped to the member's funnels
-- ---------------------------------------------------------------------------

-- The caller's selected funnel ids ('{}' for scope all / none / no active
-- membership; scope all is checked separately through app.funnel_scope_all()).
create or replace function app.my_funnel_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select app.member_funnel_ids(m.id)
    from public.workspace_members m
    where m.user_id = (select auth.uid()) and m.status = 'active'
  ), '{}'::uuid[])
$$;

-- `= any ((select app.my_funnel_ids())::uuid[])`: the cast makes the argument an
-- array expression (still a once-per-statement initPlan). Without it,
-- `any ((select ...))` parses as `= ANY (subquery)` and compares uuid = uuid[].
create policy lockdown_registry_scope on public.funnels
as restrictive for select to authenticated
using ((select app.funnel_scope_all()) or id = any ((select app.my_funnel_ids())::uuid[]));

create policy lockdown_registry_scope on public.funnel_tags
as restrictive for select to authenticated
using ((select app.funnel_scope_all()) or funnel_id = any ((select app.my_funnel_ids())::uuid[]));

-- A tag is visible through a visible funnel only (an unused tag: scope all).
create policy lockdown_registry_scope on public.tags
as restrictive for select to authenticated
using (
  (select app.funnel_scope_all())
  or exists (
    select 1 from public.funnel_tags ft
    where ft.tag_id = tags.id and ft.funnel_id = any ((select app.my_funnel_ids())::uuid[])
  )
);

-- funnel_paths: read-only for the browser (Funnels page embed), written only by
-- the definer triggers / RPCs. A restricted member sees the granted paths of
-- its own funnels, never proposals or revoked paths. The browser reads only
-- the columns the page needs: the admin metadata (note, source, FunnelFox id,
-- the *_by user ids) stays with service_role (the access function's API).
alter table public.funnel_paths enable row level security;
revoke all on table public.funnel_paths from public, anon, authenticated, service_role;
revoke all on sequence public.funnel_paths_id_seq from public, anon, authenticated, service_role;
grant select on table public.funnel_paths to service_role;
grant select (id, funnel_id, path_canonical, status, retired_at) on table public.funnel_paths to authenticated;

create policy "Members read the paths of visible funnels"
on public.funnel_paths
for select
to authenticated
using (
  (select app.funnel_scope_all())
  or (status in ('active', 'retired') and funnel_id = any ((select app.my_funnel_ids())::uuid[]))
);

create policy lockdown_active_member on public.funnel_paths
as restrictive for all to authenticated
using ((select app.is_active_member())) with check ((select app.is_active_member()));


-- ---------------------------------------------------------------------------
-- §9 Path RPCs (service_role only; called by the Edge `access` function)
-- ---------------------------------------------------------------------------

-- Active members whose selected scope holds this funnel (who sees the change).
create or replace function app.funnel_path_affected_members(p_funnel_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(distinct m.id)::integer
  from public.workspace_members m
  join public.member_scope_values v on v.member_id = m.id
  where v.dimension = 'funnel' and v.funnel_id = p_funnel_id and m.status = 'active'
$$;

-- Grants p_path to a funnel: re-activates this funnel's row (proposed, retired
-- or revoked) or inserts an admin alias. Idempotent on an active row.
-- Returns {ok, changed, path: <funnel_paths row>, affected_members}.
create or replace function public.access_attach_funnel_path(
  p_actor uuid,
  p_funnel_id uuid,
  p_path text,
  p_note text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ws public.workspaces%rowtype;
  v_actor app.access_actor;
  v_path text := btrim(coalesce(p_path, ''));
  v_note text := btrim(coalesce(p_note, ''));
  v_row public.funnel_paths%rowtype;
  v_found boolean;
  v_before jsonb;
begin
  select * into v_ws from app.lock_workspace();
  select * into v_actor from app.load_actor(v_ws.id, p_actor);
  perform app.require_permission(v_actor, 'funnels.manage');

  -- Exactly a canonical path: nothing is transformed on the admin's behalf.
  if v_path !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or v_path = 'unknown' or char_length(v_path) > 200 then
    perform app.deny('invalid', 'path must be a canonical campaign path (a-z, 0-9 and single dashes, at most 200 characters)');
  end if;
  if char_length(v_note) > 500 then
    perform app.deny('invalid', 'note must be at most 500 characters');
  end if;
  if p_funnel_id is null or not exists (select 1 from public.funnels f where f.id = p_funnel_id) then
    perform app.deny('not_found', 'funnel not found');
  end if;
  if exists (
    select 1 from public.funnel_paths fp
    where fp.path_canonical = v_path and fp.funnel_id <> p_funnel_id and fp.status in ('active', 'retired')
  ) then
    perform app.deny('conflict', 'path is already part of another funnel; revoke it there first');
  end if;

  select * into v_row from public.funnel_paths fp
  where fp.funnel_id = p_funnel_id and fp.path_canonical = v_path
  for update;
  v_found := found;
  if v_found and v_row.status = 'active' then
    return jsonb_build_object('ok', true, 'changed', false, 'path', to_jsonb(v_row),
      'affected_members', app.funnel_path_affected_members(p_funnel_id));
  end if;
  v_before := case when v_found then to_jsonb(v_row) end;

  begin
    if v_found then
      update public.funnel_paths fp
      set status = 'active', confirmed_by = p_actor, confirmed_at = now(),
          retired_at = null, revoked_by = null, revoked_at = null,
          note = case when v_note <> '' then v_note else fp.note end
      where fp.id = v_row.id
      returning * into v_row;
    else
      insert into public.funnel_paths (funnel_id, path_canonical, status, source, note, created_by, confirmed_by, confirmed_at)
      values (p_funnel_id, v_path, 'active', 'admin_alias', v_note, p_actor, p_actor, now())
      returning * into v_row;
    end if;
  exception when unique_violation then
    perform app.deny('conflict', 'path is already part of another funnel; revoke it there first');
  end;

  perform app.write_audit(
    v_ws.id, 'registry.path_attached', 'user', v_actor.user_id, v_actor.member_id,
    'funnel', p_funnel_id::text, 'success', null, v_before, to_jsonb(v_row),
    jsonb_build_object('path_id', v_row.id, 'path', v_row.path_canonical)
  );

  return jsonb_build_object('ok', true, 'changed', true, 'path', to_jsonb(v_row),
    'affected_members', app.funnel_path_affected_members(p_funnel_id));
end;
$$;

-- Status transitions (anything else is invalid; the same status is a no-op):
--   proposed -> active          registry.path_confirmed
--   proposed -> revoked         registry.path_rejected
--   active   -> retired         registry.path_retired
--   retired  -> active          registry.path_reactivated
--   active | retired -> revoked registry.path_revoked
-- A funnel's own path (canonical funnels.funnel_path) is never retired or
-- revoked here: editing the funnel's path does that consistently.
create or replace function public.access_set_funnel_path_status(
  p_actor uuid,
  p_funnel_path_id bigint,
  p_status text,
  p_note text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ws public.workspaces%rowtype;
  v_actor app.access_actor;
  v_status text := lower(btrim(coalesce(p_status, '')));
  v_note text := btrim(coalesce(p_note, ''));
  v_row public.funnel_paths%rowtype;
  v_before jsonb;
  v_event text;
  v_primary text;
begin
  select * into v_ws from app.lock_workspace();
  select * into v_actor from app.load_actor(v_ws.id, p_actor);
  perform app.require_permission(v_actor, 'funnels.manage');

  if v_status not in ('active', 'retired', 'revoked') then
    perform app.deny('invalid', 'status must be active, retired or revoked');
  end if;
  if char_length(v_note) > 500 then
    perform app.deny('invalid', 'note must be at most 500 characters');
  end if;

  select * into v_row from public.funnel_paths fp where fp.id = p_funnel_path_id for update;
  if not found then
    perform app.deny('not_found', 'funnel path not found');
  end if;

  if v_row.status = v_status then
    return jsonb_build_object('ok', true, 'changed', false, 'path', to_jsonb(v_row),
      'affected_members', app.funnel_path_affected_members(v_row.funnel_id));
  end if;

  v_event := case
    when v_row.status = 'proposed' and v_status = 'active' then 'registry.path_confirmed'
    when v_row.status = 'proposed' and v_status = 'revoked' then 'registry.path_rejected'
    when v_row.status = 'active' and v_status = 'retired' then 'registry.path_retired'
    when v_row.status = 'retired' and v_status = 'active' then 'registry.path_reactivated'
    when v_row.status in ('active', 'retired') and v_status = 'revoked' then 'registry.path_revoked'
  end;
  if v_event is null then
    perform app.deny('invalid', format('a %s path cannot become %s', v_row.status, v_status));
  end if;

  if v_status in ('retired', 'revoked') then
    select app.canonical_campaign_path(f.funnel_path) into v_primary
    from public.funnels f where f.id = v_row.funnel_id;
    if v_primary = v_row.path_canonical then
      perform app.deny('invalid', 'this is the funnel path itself: edit the funnel path instead');
    end if;
  end if;

  if v_status = 'active' and exists (
    select 1 from public.funnel_paths fp
    where fp.path_canonical = v_row.path_canonical and fp.id <> v_row.id and fp.status in ('active', 'retired')
  ) then
    perform app.deny('conflict', 'path is already part of another funnel; revoke it there first');
  end if;

  v_before := to_jsonb(v_row);
  begin
    update public.funnel_paths fp set
      status = v_status,
      confirmed_by = case when v_status = 'active' then p_actor else fp.confirmed_by end,
      confirmed_at = case when v_status = 'active' then now() else fp.confirmed_at end,
      retired_at = case when v_status = 'retired' then now() when v_status = 'active' then null else fp.retired_at end,
      revoked_by = case when v_status = 'revoked' then p_actor end,
      revoked_at = case when v_status = 'revoked' then now() end,
      note = case when v_note <> '' then v_note else fp.note end
    where fp.id = v_row.id
    returning * into v_row;
  exception when unique_violation then
    perform app.deny('conflict', 'path is already part of another funnel; revoke it there first');
  end;

  perform app.write_audit(
    v_ws.id, v_event, 'user', v_actor.user_id, v_actor.member_id,
    'funnel', v_row.funnel_id::text, 'success', null, v_before, to_jsonb(v_row),
    jsonb_build_object('path_id', v_row.id, 'path', v_row.path_canonical)
  );

  return jsonb_build_object('ok', true, 'changed', true, 'path', to_jsonb(v_row),
    'affected_members', app.funnel_path_affected_members(v_row.funnel_id));
end;
$$;


-- ---------------------------------------------------------------------------
-- §10 Cohort snapshot state: what the ACTIVE snapshot is, and how fresh
-- ---------------------------------------------------------------------------

-- claim / fail overwrite status and diagnostics (202607180001), so the Edge
-- freshness gate reads these instead: they change only when a build completes
-- (active_*) or when the rebuild tick compares the warehouse fingerprint
-- (fresh_verified_at / stale_since).
alter table public.clickhouse_cohort_snapshot_state
  add column if not exists active_validation jsonb,
  add column if not exists active_validated_at timestamptz,
  add column if not exists active_campaign_scope_version text,
  add column if not exists fresh_verified_at timestamptz,
  add column if not exists stale_since timestamptz;

-- The snapshot active today was completed with these diagnostics. Freshness is
-- left null: the first tick verifies it.
update public.clickhouse_cohort_snapshot_state
set active_validation = diagnostics -> 'validation', active_validated_at = finished_at
where status = 'completed' and active_warehouse_version is not null and active_validation is null;

-- 202607180001 body plus the active_* / freshness columns.
create or replace function public.complete_clickhouse_cohort_snapshot_build(
  p_auth_user_id uuid,
  p_build_token uuid,
  p_warehouse_version text,
  p_classification_version text,
  p_generated_at timestamptz,
  p_finished_at timestamptz,
  p_duration_ms integer,
  p_users_classified bigint,
  p_rows_inserted bigint,
  p_duplicate_users bigint,
  p_removed_or_invalidated bigint,
  p_source_transactions bigint,
  p_source_unique_users bigint,
  p_diagnostics jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected integer;
begin
  update public.clickhouse_cohort_snapshot_state set
    status = 'completed',
    active_warehouse_version = p_warehouse_version,
    active_classification_version = p_classification_version,
    active_generated_at = p_generated_at,
    building_warehouse_version = null,
    building_classification_version = null,
    build_token = null,
    lease_expires_at = null,
    finished_at = p_finished_at,
    duration_ms = p_duration_ms,
    users_classified = p_users_classified,
    rows_inserted = p_rows_inserted,
    duplicate_users = p_duplicate_users,
    removed_or_invalidated = p_removed_or_invalidated,
    source_transactions = p_source_transactions,
    source_unique_users = p_source_unique_users,
    diagnostics = p_diagnostics,
    last_error = null,
    active_validation = p_diagnostics -> 'validation',
    active_validated_at = p_finished_at,
    active_campaign_scope_version = case
      when p_diagnostics -> 'campaign_scope' ->> 'status' = 'PASS' then p_diagnostics -> 'campaign_scope' ->> 'version'
    end,
    fresh_verified_at = now(),
    stale_since = null,
    updated_at = now()
  where auth_user_id = p_auth_user_id
    and snapshot_name = 'fact_user_cohorts'
    and status = 'building'
    and build_token = p_build_token
    and building_warehouse_version = p_warehouse_version
    and building_classification_version = p_classification_version;

  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

-- The rebuild tick saw the warehouse fingerprint: the active snapshot is
-- current (true: fresh_verified_at = now) or not (false: stale since the first
-- mismatch). No state row => false.
create or replace function public.observe_clickhouse_cohort_snapshot_fingerprint(
  p_auth_user_id uuid,
  p_warehouse_version text,
  p_classification_version text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_current boolean;
begin
  select coalesce(
      s.active_warehouse_version = p_warehouse_version
        and s.active_classification_version = p_classification_version,
      false)
    into v_current
  from public.clickhouse_cohort_snapshot_state s
  where s.auth_user_id = p_auth_user_id and s.snapshot_name = 'fact_user_cohorts'
  for update;
  if not found then
    return false;
  end if;

  if v_current then
    update public.clickhouse_cohort_snapshot_state s
    set fresh_verified_at = now(), stale_since = null
    where s.auth_user_id = p_auth_user_id and s.snapshot_name = 'fact_user_cohorts';
  else
    update public.clickhouse_cohort_snapshot_state s
    set stale_since = coalesce(s.stale_since, now())
    where s.auth_user_id = p_auth_user_id and s.snapshot_name = 'fact_user_cohorts';
  end if;
  return v_current;
end;
$$;

-- fact_campaign_scope was (re)built for the snapshot that is still active.
-- Returns whether a row was updated (false when a newer build won meanwhile).
create or replace function public.set_clickhouse_campaign_scope_version(
  p_auth_user_id uuid,
  p_warehouse_version text,
  p_classification_version text,
  p_scope_version text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  affected integer;
begin
  update public.clickhouse_cohort_snapshot_state s
  set active_campaign_scope_version = p_scope_version
  where s.auth_user_id = p_auth_user_id
    and s.snapshot_name = 'fact_user_cohorts'
    and s.active_warehouse_version = p_warehouse_version
    and s.active_classification_version = p_classification_version;

  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;


-- ---------------------------------------------------------------------------
-- §11 Grants. A new function is EXECUTE-able by PUBLIC and CREATE OR REPLACE
-- keeps an existing ACL, so each one is stated explicitly.
-- ---------------------------------------------------------------------------

revoke all on function app.canonical_campaign_path(text) from public, anon, authenticated, service_role;
revoke all on function app.funnel_paths_guard() from public, anon, authenticated, service_role;
revoke all on function app.funnels_canonicalize_path() from public, anon, authenticated, service_role;
revoke all on function app.funnels_sync_paths() from public, anon, authenticated, service_role;
revoke all on function app.funnel_paths_bump_members() from public, anon, authenticated, service_role;
revoke all on function app.funnel_scope_paths(uuid[]) from public, anon, authenticated, service_role;
revoke all on function app.my_funnel_ids() from public, anon, authenticated, service_role;
revoke all on function app.funnel_path_affected_members(uuid) from public, anon, authenticated, service_role;

-- RLS helper: the registry policies above call it as authenticated.
grant execute on function app.my_funnel_ids() to authenticated;

revoke all on function public.access_attach_funnel_path(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.access_set_funnel_path_status(uuid, bigint, text, text) from public, anon, authenticated;
revoke all on function public.complete_clickhouse_cohort_snapshot_build(uuid, uuid, text, text, timestamptz, timestamptz, integer, bigint, bigint, bigint, bigint, bigint, bigint, jsonb) from public, anon, authenticated;
revoke all on function public.observe_clickhouse_cohort_snapshot_fingerprint(uuid, text, text) from public, anon, authenticated;
revoke all on function public.set_clickhouse_campaign_scope_version(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.access_attach_funnel_path(uuid, uuid, text, text) to service_role;
grant execute on function public.access_set_funnel_path_status(uuid, bigint, text, text) to service_role;
grant execute on function public.complete_clickhouse_cohort_snapshot_build(uuid, uuid, text, text, timestamptz, timestamptz, integer, bigint, bigint, bigint, bigint, bigint, bigint, jsonb) to service_role;
grant execute on function public.observe_clickhouse_cohort_snapshot_fingerprint(uuid, text, text) to service_role;
grant execute on function public.set_clickhouse_campaign_scope_version(uuid, text, text, text) to service_role;


-- ---------------------------------------------------------------------------
-- §12 Fail closed: verify the result
-- ---------------------------------------------------------------------------

do $$
declare
  v_missing text;
  v_pathless text;
begin
  -- Every public table has RLS (202610050002).
  select string_agg(c.relname, ', ' order by c.relname) into v_missing
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p')
    and not c.relrowsecurity;
  if v_missing is not null then
    raise exception 'access_phase2_scope: row level security is disabled on public table(s): %', v_missing;
  end if;

  -- Every browser-reachable public table except the access tables carries the
  -- RESTRICTIVE active-member policy (202610050003); funnel_paths, readable
  -- through column grants only, is checked below.
  select string_agg(c.relname, ', ' order by c.relname) into v_missing
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p')
    and c.relname not in (
      'workspaces', 'access_roles', 'workspace_members', 'member_scope_rules',
      'member_scope_values', 'access_audit_log', 'access_denial_counters'
    )
    and (
      has_table_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, DELETE')
      or has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE')
    )
    and not exists (
      select 1 from pg_catalog.pg_policy p
      where p.polrelid = c.oid
        and p.polname = 'lockdown_active_member'
        and not p.polpermissive
    );
  if v_missing is not null then
    raise exception using
      message = 'access_phase2_scope: public table(s) reachable by the browser without lockdown_active_member: '
        || v_missing,
      hint = 'Classify them (tenant data, actor-owned or registry) or revoke the browser grants.';
  end if;

  -- funnel_paths is written by the definer triggers and RPCs only.
  if has_table_privilege('authenticated', 'public.funnel_paths', 'INSERT, UPDATE, DELETE, TRUNCATE')
    or has_any_column_privilege('authenticated', 'public.funnel_paths', 'INSERT, UPDATE')
    or has_table_privilege('anon', 'public.funnel_paths', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
    or has_any_column_privilege('anon', 'public.funnel_paths', 'SELECT, INSERT, UPDATE') then
    raise exception 'access_phase2_scope: the browser roles can write public.funnel_paths';
  end if;
  -- The browser reads funnel_paths through column grants (which the
  -- has_table_privilege check above does not see): it keeps its lockdown
  -- policy, and the admin columns stay service-role only.
  if not exists (
    select 1 from pg_catalog.pg_policy p
    where p.polrelid = 'public.funnel_paths'::regclass and p.polname = 'lockdown_active_member' and not p.polpermissive
  ) then
    raise exception 'access_phase2_scope: public.funnel_paths has no lockdown_active_member policy';
  end if;
  select string_agg(a.attname::text, ', ' order by a.attnum) into v_missing
  from pg_catalog.pg_attribute a
  where a.attrelid = 'public.funnel_paths'::regclass and a.attnum > 0 and not a.attisdropped
    and a.attname not in ('id', 'funnel_id', 'path_canonical', 'status', 'retired_at')
    and has_column_privilege('authenticated', 'public.funnel_paths', a.attname, 'SELECT');
  if v_missing is not null or has_table_privilege('authenticated', 'public.funnel_paths', 'SELECT') then
    raise exception 'access_phase2_scope: the browser roles can read admin columns of public.funnel_paths: %', coalesce(v_missing, 'all');
  end if;

  if exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid = 'public.funnels'::regclass and t.tgname = 'funnels_bump_member_access_version'
  ) then
    raise exception 'access_phase2_scope: funnels_bump_member_access_version is still present';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid = 'public.funnel_paths'::regclass and t.tgname = 'funnel_paths_bump_member_access_version'
  ) then
    raise exception 'access_phase2_scope: funnel_paths_bump_member_access_version is missing';
  end if;

  -- Not an error: such a funnel is simply invisible to restricted members
  -- until an admin settles its path (Admin -> Funnel coverage).
  select string_agg(f.id::text, ', ' order by f.id) into v_pathless
  from public.funnels f
  where not exists (
    select 1 from public.funnel_paths fp
    where fp.funnel_id = f.id and fp.status in ('active', 'retired')
  );
  if v_pathless is not null then
    raise notice 'access_phase2_scope: funnel(s) without a granted path (invisible to restricted members): %', v_pathless;
  end if;
end
$$;
