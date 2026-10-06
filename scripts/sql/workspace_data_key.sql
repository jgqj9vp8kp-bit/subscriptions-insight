-- Deploy pre-check (scripts/deploy-functions.mjs): the workspace data key, or
-- null before bootstrap_workspace(), and whether public.funnel_paths exists
-- (migration 202610060001; the access function embeds it). Read-only.
select public.workspace_data_key()::text as data_key,
       to_regclass('public.funnel_paths') is not null as funnel_paths;
