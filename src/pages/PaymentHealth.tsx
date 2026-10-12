// Payment System Health (plan phase P2, section R): attempt quality, declines,
// retries, refunds and complaints over the Primer export in the warehouse,
// computed by the clickhouse-payment-health Edge function. Five tabs, one
// global filter bar, one request per tab (cached per access partition and
// warehouse version). Everything on screen is an aggregate or a registry
// label; the banner says what is an estimate.
//
// Access: the route needs payment_health.view (ROUTE_ACCESS, restrictedReady
// false); the PSP × MID table, the registry filters and the PSP dimensions
// appear only when the server's options response says psp_global_visible —
// the page never probes for the key. A persisted PSP selection waits for that
// answer before any windowed request is sent, so a stale filter can never turn
// into a 403.

import { useEffect, useMemo, useRef } from "react";
import { Info } from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { NoAccess } from "@/components/NoAccess";
import { usePersistedPageState } from "@/hooks/usePersistedPageState";
import { useAccess } from "@/hooks/useAccess";
import { useWarehouseVersion } from "@/hooks/useAnalyticsCache";
import { usePaymentHealthQuery } from "@/hooks/usePaymentHealth";
import { EMPTY_PAYMENT_HEALTH_QUERY } from "@/services/paymentHealthDataSource";
import { traceMark } from "@/services/performanceTrace";
import { PaymentHealthFilterBar } from "@/components/payment-health/PaymentHealthFilterBar";
import { OverviewTab } from "@/components/payment-health/OverviewTab";
import { DeclinesTab } from "@/components/payment-health/DeclinesTab";
import { RetriesTab } from "@/components/payment-health/RetriesTab";
import { RefundsComplaintsTab } from "@/components/payment-health/RefundsComplaintsTab";
import { SourcesTab } from "@/components/payment-health/SourcesTab";
import { dimensionOptions } from "@/components/payment-health/model";
import {
  DEFAULT_PAYMENT_HEALTH_UI_STATE,
  PAYMENT_HEALTH_TABS,
  PAYMENT_HEALTH_UI_STATE_KEY,
  TAB_LABELS,
  coerceTab,
  customRangeProblem,
  effectiveQuery,
  hasPspSelection,
  type PaymentHealthTab,
  type PaymentHealthUiState,
} from "@/components/payment-health/pageState";
import { fmtDay, todayUtc } from "@/components/payment-health/format";
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
  const clearFilters = () => setUiState((current) => ({ ...DEFAULT_PAYMENT_HEALTH_UI_STATE, tab: current.tab, dimension: current.dimension }));
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
              <TabsTrigger key={key} value={key} className="text-xs sm:text-sm">{TAB_LABELS[key]}</TabsTrigger>
            ))}
          </TabsList>
          {/* Only the active tab mounts its query: the others fetch when opened and keep their cache. */}
          <TabsContent value="overview" className="mt-4">{tab === "overview" && <OverviewTab {...tabProps} />}</TabsContent>
          <TabsContent value="declines" className="mt-4">{tab === "declines" && <DeclinesTab {...tabProps} dimensionSelect={dimensionSelect} />}</TabsContent>
          <TabsContent value="retries" className="mt-4">{tab === "retries" && <RetriesTab {...tabProps} />}</TabsContent>
          <TabsContent value="refunds" className="mt-4">{tab === "refunds" && <RefundsComplaintsTab {...tabProps} dimensionSelect={dimensionSelect} />}</TabsContent>
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
