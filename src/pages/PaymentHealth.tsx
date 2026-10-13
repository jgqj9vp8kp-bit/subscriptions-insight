// Payment System Health (plan phase P2, section R): attempt quality, declines,
// retries, refunds and complaints over the Primer export in the warehouse,
// computed by the clickhouse-payment-health Edge function. Six tabs, one
// global filter bar, one request per tab (cached per access partition and
// warehouse version). Everything on screen is an aggregate or a registry
// label; the banner says what is an estimate. The Alerts tab (P2.5) reads the
// daily checks' alerts; its open count is the tab's badge (one alerts_list
// request per partition, shared with the tab's default view).
//
// Access: the route needs payment_health.view (ROUTE_ACCESS, restrictedReady
// false); the PSP × MID table, the registry filters and the PSP dimensions
// appear only when the server's options response says psp_global_visible —
// the page never probes for the key. A persisted PSP selection waits for that
// answer before any windowed request is sent, so a stale filter can never turn
// into a 403. The alert status buttons and "Run checks now" follow the
// privileged payment_health.manage_alerts of the access context (and the
// server's meta.can_manage); the server re-checks every change.

import { useContext, useEffect, useMemo, useRef } from "react";
import { Info } from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { NoAccess } from "@/components/NoAccess";
import { usePersistedPageState } from "@/hooks/usePersistedPageState";
import { useAccess } from "@/hooks/useAccess";
import { useWarehouseVersion } from "@/hooks/useAnalyticsCache";
import { usePaymentAlertsQuery, usePaymentHealthQuery } from "@/hooks/usePaymentHealth";
import { AuthContext } from "@/contexts/authContext";
import { EMPTY_PAYMENT_HEALTH_QUERY, OPEN_ALERTS_FILTERS } from "@/services/paymentHealthDataSource";
import { cn } from "@/lib/utils";
import { traceMark } from "@/services/performanceTrace";
import { PaymentHealthFilterBar } from "@/components/payment-health/PaymentHealthFilterBar";
import { OverviewTab } from "@/components/payment-health/OverviewTab";
import { DeclinesTab } from "@/components/payment-health/DeclinesTab";
import { RetriesTab } from "@/components/payment-health/RetriesTab";
import { RefundsComplaintsTab } from "@/components/payment-health/RefundsComplaintsTab";
import { SourcesTab } from "@/components/payment-health/SourcesTab";
import { AlertsTab } from "@/components/payment-health/AlertsTab";
import { MANAGE_ALERTS_PERMISSION } from "@/components/payment-health/alertsModel";
import { dimensionOptions } from "@/components/payment-health/model";
import {
  DEFAULT_PAYMENT_HEALTH_UI_STATE,
  PAYMENT_HEALTH_TABS,
  PAYMENT_HEALTH_UI_STATE_KEY,
  TAB_LABELS,
  coerceAlertSeverityFilter,
  coerceAlertStatusFilter,
  coerceTab,
  customRangeProblem,
  effectiveQuery,
  hasPspSelection,
  type PaymentHealthTab,
  type PaymentHealthUiState,
} from "@/components/payment-health/pageState";
import { fmtDay, fmtNum, todayUtc } from "@/components/payment-health/format";
import { windowsFor, type PaymentHealthDimension } from "../../supabase/functions/_shared/clickhouse/paymentHealthContract";

export default function PaymentHealthPage() {
  const mountedRef = useRef(false);
  if (!mountedRef.current) {
    mountedRef.current = true;
    traceMark("route.payment_health.mounted");
  }

  const access = useAccess();
  const [uiState, setUiState] = usePersistedPageState<PaymentHealthUiState>(PAYMENT_HEALTH_UI_STATE_KEY, DEFAULT_PAYMENT_HEALTH_UI_STATE);
  const update = (patch: Partial<PaymentHealthUiState>) => setUiState((current) => ({ ...current, ...patch }));
  // "Clear" is about the filters: the open tab and the breakdown dimension are
  // navigation, and jumping back to Overview on a clear reads as a bug.
  // The Alerts tab's own filters are not the bar's either.
  const clearFilters = () =>
    setUiState((current) => ({ ...DEFAULT_PAYMENT_HEALTH_UI_STATE, tab: current.tab, dimension: current.dimension, alertStatus: current.alertStatus, alertSeverity: current.alertSeverity }));
  const tab = coerceTab(uiState.tab);

  // The access partition keys every query (plan §20); the warehouse version
  // re-keys them after an import + sync.
  const userScopeHash = access.partition;
  const { version: warehouseVersion, ready: warehouseVersionReady } = useWarehouseVersion(true);

  // Filter options and the PSP visibility come from the options action (whole
  // tenant history, no filters: one entry per partition + warehouse version).
  const options = usePaymentHealthQuery({
    action: "options",
    query: EMPTY_PAYMENT_HEALTH_QUERY,
    userScopeHash,
    warehouseVersion,
    enabled: warehouseVersionReady,
  });
  const pspVisible = options.data?.meta.psp_global_visible === true;
  const optionsSettled = options.data != null || options.error != null;
  // A persisted PSP filter or dimension must not be sent before the server has
  // said whether it may be; everything else goes out in parallel with options.
  // A custom window the server would refuse (from after to, over the maximum)
  // is held back too, with the reason in the filter bar and in the tab.
  const rangeProblem = customRangeProblem(uiState);
  const windowedEnabled = warehouseVersionReady && rangeProblem == null && (optionsSettled || !hasPspSelection(uiState));
  const idleNote = rangeProblem
    ? `${rangeProblem} Fix the window in the filter bar.`
    : !warehouseVersionReady
      ? "Resolving the warehouse version…"
      : "Waiting for the filter options before sending the remembered processor / account selection…";

  const today = todayUtc();
  const query = useMemo(() => effectiveQuery(uiState, pspVisible, today), [uiState, pspVisible, today]);

  // The breakdown dimension the declines / refunds tabs show: the persisted one
  // when it is still offered, else the server default for this caller.
  const dimension: PaymentHealthDimension = query.dimension ?? (pspVisible ? "processor" : "funnel");
  const dimensionSelect = {
    value: dimensionOptions(pspVisible).includes(dimension) ? dimension : dimensionOptions(pspVisible)[0],
    onChange: (next: PaymentHealthDimension) => update({ dimension: next }),
    pspVisible,
  };

  useEffect(() => {
    document.title = "Payment System Health • Subengine";
  }, []);

  const tabProps = { query, userScopeHash, warehouseVersion, enabled: windowedEnabled, pspVisible, idleNote };

  // Alerts: Postgres-only on the server, so they do not wait for the warehouse
  // version or the options answer. A funnel-restricted member would get 403
  // (no alert action is scope-ready): no request at all.
  const alertsEnabled = !access.restricted;
  const openAlerts = usePaymentAlertsQuery({ filters: OPEN_ALERTS_FILTERS, userScopeHash, enabled: alertsEnabled });
  const openCount = openAlerts.data?.counts.open ?? 0;
  const openCountText = openAlerts.data?.meta.limited ? `${fmtNum(openCount)}+` : fmtNum(openCount);
  const openBySeverity = openAlerts.data?.counts.open_by_severity;
  const badgeTone = openBySeverity?.critical ? "bg-destructive text-destructive-foreground" : openBySeverity?.warning ? "bg-warning text-warning-foreground" : "bg-muted-foreground/20 text-foreground";
  const canManageAlerts = access.can(MANAGE_ALERTS_PERMISSION);
  const currentUserId = useContext(AuthContext)?.user?.id ?? null;
  const dataThrough = options.data?.meta.data_through ?? null;
  // The banner's "data through" comes from options: an ellipsis while it loads,
  // "unknown" after a failure (never a stale or made-up day).
  const dataThroughText = dataThrough ? fmtDay(dataThrough) : options.data ? "—" : options.error ? "unknown" : "…";
  const optionsAccessDenied = options.error?.kind === "access";
  // The compare caption before the first windowed response: the server's own
  // window arithmetic (UTC days), null while a custom window is half filled.
  const windows = query.dateFrom && query.dateTo && query.dateFrom <= query.dateTo ? windowsFor(query.dateFrom, query.dateTo) : null;

  return (
    <AppLayout title="Payment System Health" description="Approvals, declines, retries, refunds and complaints — estimates from the Primer export">
      <div className="space-y-4">
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
          data-testid="payment-health-banner"
        >
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <span>
            Estimates from the Primer export; data through <span className="font-mono text-foreground">{dataThroughText}</span>; network ratios need
            official reports. Declines are classified by issuer, Primer and advice codes; an issuer's suspicion code is a decline, not fraud.
          </span>
        </div>

        <PaymentHealthFilterBar
          state={uiState}
          onChange={update}
          onReset={clearFilters}
          options={options.data?.options ?? null}
          optionsLoading={options.isInitialLoading}
          optionsError={options.error}
          onRetryOptions={options.refetch}
          pspVisible={pspVisible}
          range={windows?.range ?? null}
          compare={windows?.compare ?? null}
          rangeProblem={rangeProblem}
        />

        <Tabs value={tab} onValueChange={(value) => update({ tab: coerceTab(value) })}>
          <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1">
            {PAYMENT_HEALTH_TABS.map((key: PaymentHealthTab) => (
              <TabsTrigger key={key} value={key} className="text-xs sm:text-sm">
                {TAB_LABELS[key]}
                {key === "alerts" && openCount > 0 && (
                  <span
                    className={cn("ml-1.5 inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 text-[10px] font-semibold leading-4", badgeTone)}
                    title={`${openCountText} open alert(s)`}
                    data-testid="alerts-tab-count"
                  >
                    {openCountText}
                  </span>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
          {/* Only the active tab mounts its query: the others fetch when opened and keep their cache. */}
          <TabsContent value="overview" className="mt-4">{tab === "overview" && <OverviewTab {...tabProps} />}</TabsContent>
          <TabsContent value="declines" className="mt-4">{tab === "declines" && <DeclinesTab {...tabProps} dimensionSelect={dimensionSelect} />}</TabsContent>
          <TabsContent value="retries" className="mt-4">{tab === "retries" && <RetriesTab {...tabProps} />}</TabsContent>
          <TabsContent value="refunds" className="mt-4">{tab === "refunds" && <RefundsComplaintsTab {...tabProps} dimensionSelect={dimensionSelect} />}</TabsContent>
          <TabsContent value="alerts" className="mt-4">
            {tab === "alerts" && (
              <AlertsTab
                userScopeHash={userScopeHash}
                enabled={alertsEnabled}
                statusFilter={coerceAlertStatusFilter(uiState.alertStatus)}
                severityFilter={coerceAlertSeverityFilter(uiState.alertSeverity)}
                onFiltersChange={update}
                canManage={canManageAlerts}
                currentUserId={currentUserId}
                onReproduce={update}
              />
            )}
          </TabsContent>
          <TabsContent value="sources" className="mt-4">
            {/* Sources is tenant-wide (no window, no filters). After an access denial on options the same gate would refuse it: show the shell instead of asking again. */}
            {tab === "sources" && optionsAccessDenied && <NoAccess reason={options.error?.errorCode === "scope_not_supported" ? "scope" : "permission"} />}
            {tab === "sources" && !optionsAccessDenied && <SourcesTab userScopeHash={userScopeHash} warehouseVersion={warehouseVersion} enabled={warehouseVersionReady} />}
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
