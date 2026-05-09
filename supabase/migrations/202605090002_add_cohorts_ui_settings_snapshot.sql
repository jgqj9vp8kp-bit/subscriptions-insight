alter table public.data_snapshots
drop constraint if exists data_snapshots_dataset_type_check;

alter table public.data_snapshots
add constraint data_snapshots_dataset_type_check
check (
  dataset_type in (
    'palmer',
    'funnelfox_subscriptions',
    'facebook_traffic',
    'forecasting_settings',
    'cohorts_ui_settings'
  )
);
