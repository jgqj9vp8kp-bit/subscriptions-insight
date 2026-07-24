create extension if not exists pgcrypto;

-- Funnels admin registry (Funnels page). NOT analytics: this is a manually
-- curated registry of funnel_path values (== ff_campaign_path / campaign_path
-- elsewhere in the pipeline) with a display name, an active/inactive flag and
-- reusable tags. Independent of whether any transaction has landed for a
-- path yet -- ClickHouse is never joined against these tables directly.
--
-- Deployment-shared, not per-user (see plan §1): this Supabase project has
-- 3 real auth.users accounts and no workspace/organization concept anywhere
-- in the schema. A funnel taxonomy describes one business, not "whichever
-- account happened to import it" -- so RLS here grants full read/write to
-- any authenticated user, unlike every other table in this codebase.
-- created_by is kept for audit display only and is never read by a policy.
create table public.funnels (
  id uuid primary key default gen_random_uuid(),
  funnel_path text not null,
  display_name text not null default '',
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (funnel_path)
);

create index funnels_is_active_idx on public.funnels (is_active);

create or replace function public.set_funnels_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger funnels_set_updated_at
before update on public.funnels
for each row
execute function public.set_funnels_updated_at();

alter table public.funnels enable row level security;

create policy "Authenticated users can read funnels"
on public.funnels
for select
to authenticated
using (true);

create policy "Authenticated users can insert funnels"
on public.funnels
for insert
to authenticated
with check (true);

create policy "Authenticated users can update funnels"
on public.funnels
for update
to authenticated
using (true)
with check (true);

-- Deliberately NO delete policy. is_active is the sole retirement
-- mechanism in v1 -- there is no PostgREST-reachable delete path and no UI
-- affordance for it.


-- Tags: reusable, first-class entities, also deployment-shared.
create table public.tags (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Case-insensitive, whitespace-insensitive uniqueness needs a real
-- expression index -- Postgres does not allow an expression inside an
-- inline `unique (...)` table constraint (only plain columns). Application
-- writes additionally btrim() the name before insert/update so the
-- DISPLAYED value has no stray whitespace either; the index alone only
-- prevents duplicates, it doesn't clean existing text.
create unique index tags_name_unique_idx
  on public.tags (lower(btrim(name)));

alter table public.tags enable row level security;

create policy "Authenticated users can read tags"
on public.tags
for select
to authenticated
using (true);

create policy "Authenticated users can insert tags"
on public.tags
for insert
to authenticated
with check (true);

create policy "Authenticated users can update tags"
on public.tags
for update
to authenticated
using (true)
with check (true);

create policy "Authenticated users can delete tags"
on public.tags
for delete
to authenticated
using (true);
-- Tag deletion stays in scope (unlike funnel deletion). Deleting a tag
-- cascades its funnel_tags rows via the FK below.


-- Many-to-many join. No owner column of its own.
create table public.funnel_tags (
  funnel_id uuid not null references public.funnels(id) on delete cascade,
  tag_id uuid not null references public.tags(id) on delete cascade,
  created_at timestamptz not null default now(),

  primary key (funnel_id, tag_id)
);

create index funnel_tags_tag_id_idx on public.funnel_tags (tag_id);

alter table public.funnel_tags enable row level security;

-- Reads go straight through PostgREST (needed for the funnels list's
-- embedded tag select). Writes deliberately get NO insert/update/delete
-- policy -- replace_funnel_tags() below is the only sanctioned mutation
-- path, so a stray direct PostgREST call can't bypass its atomicity.
create policy "Authenticated users can read funnel tags"
on public.funnel_tags
for select
to authenticated
using (true);


-- Atomic tag replacement for one funnel. security definer (not invoker):
-- funnel_tags has no write policy at all, so an invoker-security function
-- would be blocked by RLS on its own internal delete/insert. Definer runs
-- as the function's owner (the migration-running role, which has
-- BYPASSRLS in Supabase's managed Postgres), which is how this table's
-- writes stay reachable only through this one validated, atomic path.
create or replace function public.replace_funnel_tags(p_funnel_id uuid, p_tag_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_missing_tags uuid[];
begin
  if not exists (select 1 from public.funnels where id = p_funnel_id) then
    raise exception 'Funnel % not found', p_funnel_id using errcode = 'no_data_found';
  end if;

  select array_agg(t) into v_missing_tags
  from unnest(coalesce(p_tag_ids, array[]::uuid[])) as t
  where not exists (select 1 from public.tags where id = t);

  if v_missing_tags is not null then
    raise exception 'Unknown tag id(s): %', v_missing_tags using errcode = 'no_data_found';
  end if;

  delete from public.funnel_tags where funnel_id = p_funnel_id;

  insert into public.funnel_tags (funnel_id, tag_id)
  select p_funnel_id, t from unnest(coalesce(p_tag_ids, array[]::uuid[])) as t;

  return jsonb_build_object(
    'funnel_id', p_funnel_id,
    'tag_count', coalesce(array_length(p_tag_ids, 1), 0)
  );
end;
$$;

revoke all on function public.replace_funnel_tags(uuid, uuid[]) from public;
grant execute on function public.replace_funnel_tags(uuid, uuid[]) to authenticated;
