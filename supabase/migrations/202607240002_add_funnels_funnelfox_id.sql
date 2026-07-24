-- Stable FunnelFox identity for registry rows.
--
-- funnel_path is NOT stable: a funnel can be re-pathed in FunnelFox while
-- staying the same funnel. Confirmed in this project's own production data --
-- 3 of 43 FunnelFox funnel_ids already map to two campaign_path values each:
--   01KMN4TNEV27GPXXFFXJRYXM2D  /starseed-reading-sp    + /starseed-reading-spain
--   01KTKBKEHTK6WCNV9TVDJWQHBS  /soulmate-1-tariff-month-veb + /soulmate-sketch
--   01KTP2K149289BWYH0924N0X3D  /astroline-jp           + /palm-reading
--
-- Without a stable key the FunnelFox import would insert a SECOND row after
-- each rename instead of updating the existing one. funnel_path stays the
-- display value and the join key for Cohorts/campaign_path; this column is
-- the upsert identity and the provenance marker (null = created by hand).
alter table public.funnels
  add column if not exists funnelfox_funnel_id text;

-- Partial: many hand-created rows may legitimately have no FunnelFox id, but
-- no two rows may claim the SAME one.
create unique index if not exists funnels_funnelfox_funnel_id_unique_idx
  on public.funnels (funnelfox_funnel_id)
  where funnelfox_funnel_id is not null;
