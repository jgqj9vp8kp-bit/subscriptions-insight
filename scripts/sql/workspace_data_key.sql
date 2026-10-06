-- Deploy pre-check (scripts/deploy-functions.mjs): the workspace data key, or
-- null before bootstrap_workspace(). Read-only.
select public.workspace_data_key()::text as data_key;
