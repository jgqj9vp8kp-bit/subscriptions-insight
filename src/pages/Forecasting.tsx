// Payback by funnel (/forecasting; spec 2026-10-24, Phase 1). For every funnel:
// its trials in the period, the Facebook spend behind them (plus the 4 %
// agency fee), and how much of that cost the trials pay back within 30, 60 and
// 90 days — observed where the trials are old enough, projected from real
// older revenue where they are not (src/services/ltvPayback.ts holds every
// definition). Reads the server only: the clickhouse-cohorts "ltv" curve and
// one clickhouse-facebook spend_ledger call per window. No transactions in the
// browser, no computeCohorts, no traffic metrics — the old planner with those
// lives at /forecasting/legacy.
//
// Facebook spend can stop before the payments do (spend_through, spec §10):
// trials after it are never paired with $0 spend — they are "No spend data",
// and a banner says how far the spend goes. The trials themselves can stop
// before the payments do too, while the cohort snapshot is stale: the page
// then cuts trials and spend at the snapshot's newest trial, says so, and (for
// whoever may rebuild it) starts the same background rebuild as Cohorts.
//
// All state is in the URL (paybackState.ts). Access: forecasting.view, closed
// to funnel-restricted members until the page's access Phase 2.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Download, RefreshCw, TriangleAlert } from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { downloadTable, type ExportFormat } from "@/lib/tableExport";
import { useAccess } from "@/hooks/useAccess";
import { useCohortProducts } from "@/hooks/useCohortProducts";
import {
  PaybackLtvError,
  PAYBACK_SNAPSHOT_NOT_READY,
  paybackSnapshotHealth,
  usePaybackFunnelNames,
  usePaybackLedger,
  usePaybackLtv,
  usePaybackTrendLedgers,
  usePaybackWarehouseVersion,
} from "@/hooks/usePayback";
import { canAccessRoute } from "@/services/accessRoutes";
import { ensureCohortSnapshotRebuild } from "@/services/cohortSnapshotHealth";
import { productKey, productPathSet } from "@/services/cohortProductFilter";
import {
  PAYBACK_AGENCY_FEE_DEFAULT,
  PAYBACK_SMALL_FUNNELS_KEY,
  PAYBACK_TOTAL_KEY,
  computePayback,
  paybackLedgerWindow,
  paybackProductGroups,
  paybackSpendFromLedger,
  paybackTrend,
  paybackTrialsThrough,
  type PaybackAgencyFee,
  type PaybackInput,
  type PaybackResult,
} from "@/services/ltvPayback";
import { InfoTip } from "@/components/payback/InfoTip";
import { PaybackFilters } from "@/components/payback/PaybackFilters";
import { PaybackKpis } from "@/components/payback/PaybackKpis";
import { PaybackSheet, type PaybackTrendEntry } from "@/components/payback/PaybackSheet";
import { PaybackTable } from "@/components/payback/PaybackTable";
import { buildPaybackExportTable, findPaybackRow, paybackExportFileName, paybackFunnelOptions, paybackRowLabel } from "@/components/payback/paybackView";
import { PAYBACK_COPY } from "@/components/payback/paybackCopy";
import { fmtDay, fmtMoney } from "@/components/payback/paybackFormat";
import {
  defaultCustomMonths,
  paybackLtvRange,
  paybackPeriodWindow,
  paybackTrendWindows,
  readPaybackUrl,
  utcToday,
  writePaybackUrl,
  type PaybackPeriod,
  type PaybackShow,
  type PaybackSortKey,
  type PaybackUrlState,
} from "@/components/payback/paybackState";

const COPY = PAYBACK_COPY;
const FEE_OFF: PaybackAgencyFee = Object.freeze({ ...PAYBACK_AGENCY_FEE_DEFAULT, enabled: false });

function StateCard({ children, action }: { children: string; action?: { label: string; onClick: () => void } }) {
  return (
    <Card className="flex flex-wrap items-center justify-center gap-3 p-8 text-center text-sm text-muted-foreground shadow-card" role="status">
      <span>{children}</span>
      {action && <Button variant="outline" size="sm" onClick={action.onClick}>{action.label}</Button>}
    </Card>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="space-y-3" role="status" aria-label={label}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-[92px]" />)}
      </div>
      <Card className="space-y-2 p-3 shadow-card">
        <p className="text-xs text-muted-foreground">{label}</p>
        {Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-7" />)}
      </Card>
    </div>
  );
}

function Chip({ children, info, label, tone = "muted" }: { children: string; info: string; label: string; tone?: "muted" | "warn" }) {
  return (
    <span
      className={cn(
        "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs",
        tone === "warn" ? "border-warning/50 bg-warning/10 text-foreground" : "border-border text-muted-foreground",
      )}
    >
      {children}
      <InfoTip label={label}>{info}</InfoTip>
    </span>
  );
}

export default function ForecastingPage() {
  const access = useAccess();
  const [searchParams, setSearchParams] = useSearchParams();
  const state = useMemo(() => readPaybackUrl(searchParams), [searchParams]);
  const update = useCallback(
    (patch: Partial<PaybackUrlState>) => setSearchParams((current) => writePaybackUrl({ ...readPaybackUrl(current), ...patch }, current), { replace: true }),
    [setSearchParams],
  );
  const [today] = useState(() => utcToday());
  const [smallOpen, setSmallOpen] = useState(false);

  // ---- period and data -------------------------------------------------------------------
  const { window, problem } = useMemo(() => paybackPeriodWindow(state, today), [state, today]);
  const range = useMemo(() => (window ? paybackLtvRange(window) : null), [window]);
  const ltvQuery = usePaybackLtv(range);
  const ltv = ltvQuery.data;
  // Trials (and the spend paired with them) go to data_through, or to the
  // snapshot's newest trial while it is stale.
  const trialsThrough = ltv ? paybackTrialsThrough(ltv) : null;
  const ledgerWindow = useMemo(() => (window ? paybackLedgerWindow(window, trialsThrough) : null), [window, trialsThrough]);
  const ledgerQuery = usePaybackLedger(ledgerWindow);
  const spend = useMemo(() => (ledgerQuery.data ? paybackSpendFromLedger(ledgerQuery.data) : null), [ledgerQuery.data]);
  const names = usePaybackFunnelNames();

  // A stale snapshot: one background rebuild per staleness observation, shared
  // with the Cohorts page (single-flight). It writes the warehouse, so only for
  // admin.warehouse.manage; its completion event refetches this page.
  const canRebuildSnapshot = access.can("admin.warehouse.manage");
  const snapshotHealth = useMemo(() => paybackSnapshotHealth(ltv), [ltv]);
  useEffect(() => {
    if (canRebuildSnapshot && snapshotHealth) ensureCohortSnapshotRebuild(snapshotHealth);
  }, [canRebuildSnapshot, snapshotHealth]);

  // ---- product and funnel selection -------------------------------------------------------
  const { version: warehouseVersion, ready: versionReady } = usePaybackWarehouseVersion();
  const { products } = useCohortProducts({ userScopeHash: access.partition, warehouseVersion, enabled: versionReady });
  const productGroups = useMemo(() => paybackProductGroups(products), [products]);
  const selectedProducts = useMemo(() => {
    if (!products) return [];
    const known = new Set(products.map(productKey));
    return state.products.filter((key) => known.has(key));
  }, [products, state.products]);
  const productPaths = useMemo(() => productPathSet(products, selectedProducts), [products, selectedProducts]);
  const funnelOptions = useMemo(() => paybackFunnelOptions(ltv, window, spend, productPaths, names), [ltv, window, spend, productPaths, names]);
  const optionIds = useMemo(() => funnelOptions.map((option) => option.id), [funnelOptions]);
  const selectedFunnelSet = useMemo(
    () => new Set(state.funnels === null ? optionIds : state.funnels.filter((path) => optionIds.includes(path))),
    [state.funnels, optionIds],
  );
  // The model's funnel filter: null = every funnel in scope.
  const funnels = useMemo<string[] | null>(() => {
    if (state.funnels === null) return productPaths ? [...productPaths].sort() : null;
    return state.funnels.filter((path) => !productPaths || productPaths.has(path));
  }, [state.funnels, productPaths]);

  const toggleFunnel = (path: string) => {
    const next = new Set(state.funnels ?? optionIds);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    const all = optionIds.every((id) => next.has(id)) && next.size === optionIds.length;
    update({ funnels: all ? null : [...next].sort() });
  };
  const toggleProduct = (key: string) => {
    const next = selectedProducts.includes(key) ? selectedProducts.filter((entry) => entry !== key) : [...selectedProducts, key];
    // The funnel pick belonged to the previous products.
    update({ products: next, funnels: null });
  };

  // ---- the model --------------------------------------------------------------------------
  const agencyFee = state.agencyFee ? PAYBACK_AGENCY_FEE_DEFAULT : FEE_OFF;
  const spendSettled = ledgerWindow === null || ledgerQuery.settled;
  const result = useMemo<PaybackResult | null>(() => {
    if (!ltv || !window || !spendSettled) return null;
    return computePayback({ ltv, window, spend, funnels, products: productGroups, agencyFee });
  }, [ltv, window, spendSettled, spend, funnels, productGroups, agencyFee]);

  // ---- drilldown --------------------------------------------------------------------------
  const sheetRow = result ? findPaybackRow(result, state.open) : null;
  const trendWindows = useMemo(() => (window ? paybackTrendWindows(window) : []), [window]);
  const trendLedgerWindows = useMemo(
    () => trendWindows.map((month) => paybackLedgerWindow(month, trialsThrough)),
    [trendWindows, trialsThrough],
  );
  const trendLedgers = usePaybackTrendLedgers(trendLedgerWindows, sheetRow !== null);
  const sheetKey = sheetRow?.key ?? null;
  const smallPaths = useMemo(() => result?.small?.rows.map((row) => row.key) ?? [], [result]);
  const trend = useMemo<PaybackTrendEntry[]>(() => {
    if (!sheetKey || !ltv) return [];
    const base: Omit<PaybackInput, "window" | "spend" | "funnels"> = { ltv, products: productGroups, agencyFee };
    return trendWindows.map((month, index) => {
      const ledger = trendLedgers[index];
      if (ledger?.loading) return { window: month, row: null, loading: true };
      const monthSpend = ledger?.data ? paybackSpendFromLedger(ledger.data) : null;
      if (sheetKey === PAYBACK_TOTAL_KEY || sheetKey === PAYBACK_SMALL_FUNNELS_KEY) {
        const scope = sheetKey === PAYBACK_TOTAL_KEY ? funnels : smallPaths;
        return { window: month, row: computePayback({ ...base, window: month, spend: monthSpend, funnels: scope }).total, loading: false };
      }
      return { window: month, row: paybackTrend(base, sheetKey, [{ window: month, spend: monthSpend }])[0]?.row ?? null, loading: false };
    });
  }, [sheetKey, ltv, productGroups, agencyFee, trendWindows, trendLedgers, funnels, smallPaths]);

  // ---- export -----------------------------------------------------------------------------
  const exportTable = (format: ExportFormat) => {
    if (!result) return;
    void downloadTable(buildPaybackExportTable(result, { sort: state.sort, show: state.show, names, smallOpen }), format, paybackExportFileName(window), COPY.export.sheetName);
  };

  const onSort = (key: PaybackSortKey) => {
    const dir = state.sort.key === key ? (state.sort.dir === "desc" ? "asc" : "desc") : key === "funnel" ? "asc" : "desc";
    update({ sort: { key, dir } });
  };
  const onPeriod = (period: PaybackPeriod) => {
    if (period === "custom") update({ period, ...defaultCustomMonths(today) });
    else update({ period, fromMonth: null, toMonth: null });
  };
  const customMonths = state.period === "custom"
    ? { fromMonth: state.fromMonth ?? defaultCustomMonths(today).fromMonth, toMonth: state.toMonth ?? defaultCustomMonths(today).toMonth }
    : defaultCustomMonths(today);

  const legacyLink = canAccessRoute("/forecasting/legacy", access) ? (
    <Link to="/forecasting/legacy" className="whitespace-nowrap text-xs text-muted-foreground hover:text-foreground hover:underline" title={COPY.page.oldPlannerTitle}>
      {COPY.page.oldPlanner}
    </Link>
  ) : null;

  // ---- header chips -------------------------------------------------------------------------
  const spendThrough = spend?.spendThrough ?? null;
  const chips = (
    <div className="flex flex-wrap items-center gap-2">
      {ltv?.data_through && (
        <Chip label={COPY.aria.paymentsDate} info={COPY.chips.paymentsInfo}>{COPY.chips.paymentsThrough(fmtDay(ltv.data_through))}</Chip>
      )}
      {spend && (
        <Chip label={COPY.aria.facebookDate} info={COPY.chips.facebookInfo} tone={result?.spendBanner ? "warn" : "muted"}>
          {spendThrough ? COPY.chips.facebookThrough(fmtDay(spendThrough)) : COPY.chips.facebookNone}
        </Chip>
      )}
      <label className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border px-2.5 text-xs">
        <Switch checked={state.agencyFee} onCheckedChange={(checked) => update({ agencyFee: checked })} aria-label={COPY.chips.agencyFee} className="-mx-1.5 scale-75" />
        {COPY.chips.agencyFee}
        <InfoTip label={COPY.aria.agencyFee}>{COPY.chips.agencyFeeInfo}</InfoTip>
      </label>
    </div>
  );

  // ---- banner -------------------------------------------------------------------------------
  let banner: { text: string; retry?: () => void } | null = null;
  if (result?.windowReasons.includes("spend_unavailable") && ledgerWindow) banner = { text: COPY.banner.spendFailed, retry: ledgerQuery.refetch };
  else if (result?.spendBanner) {
    banner = { text: result.spendBanner.through ? COPY.banner.spendThrough(fmtDay(result.spendBanner.through)) : COPY.banner.noSpend };
  }

  // ---- body ---------------------------------------------------------------------------------
  let body: ReactNode = null;
  if (problem) body = null;
  else if (ltvQuery.loading) body = <LoadingState label={COPY.states.loading} />;
  else if (ltvQuery.error && !ltv) {
    const notReady = ltvQuery.error instanceof PaybackLtvError && ltvQuery.error.code === PAYBACK_SNAPSHOT_NOT_READY;
    body = <StateCard action={{ label: COPY.banner.retry, onClick: ltvQuery.refetch }}>{notReady ? COPY.states.snapshotNotReady : COPY.states.failed}</StateCard>;
  } else if (ltv && !spendSettled) body = <LoadingState label={COPY.states.loadingSpend} />;
  else if (result && !result.revenueWindow) body = <StateCard>{COPY.states.noPayments}</StateCard>;
  else if (result && funnels !== null && funnels.length === 0) body = <StateCard>{COPY.states.noFunnelPicked}</StateCard>;
  else if (result && result.rows.length === 0 && !result.small) body = <StateCard>{COPY.states.noTrials}</StateCard>;
  else if (result) {
    body = (
      <>
        <PaybackKpis total={result.total} agencyFee={agencyFee.enabled} spendThrough={result.spendThrough} />
        <Card className="min-w-0 p-3 shadow-card">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">{COPY.table.title}</h2>
            <div className="flex flex-wrap items-center gap-2">
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={state.show}
                aria-label={COPY.filters.show}
                onValueChange={(value) => { if (value) update({ show: value as PaybackShow }); }}
              >
                {(["back", "ltv"] as const).map((value) => (
                  <ToggleGroupItem key={value} value={value} className="h-7 px-2 text-xs">{COPY.filters.shows[value]}</ToggleGroupItem>
                ))}
              </ToggleGroup>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs">
                    <Download className="h-3.5 w-3.5" /> {COPY.filters.export}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => exportTable("csv")}>{COPY.filters.exportCsv}</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => exportTable("xlsx")}>{COPY.filters.exportXlsx}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          <PaybackTable
            result={result}
            show={state.show}
            sort={state.sort}
            onSort={onSort}
            names={names}
            openKey={state.open}
            onOpen={(key) => update({ open: key })}
            smallOpen={smallOpen}
            onToggleSmall={() => setSmallOpen((current) => !current)}
            footer={
              <div className="mt-2 space-y-0.5 text-[11px] text-muted-foreground">
                <p>{COPY.table.legend}</p>
                {result.total.trialsAfterSpendThrough > 0 && result.spendThrough && (
                  <p data-testid="payback-after-spend">
                    {/* Not evaluated: the later trials are the ones the Total row counts. */}
                    {(result.total.evaluated ? COPY.table.afterSpend : COPY.table.allAfterSpend)(result.total.trialsAfterSpendThrough, fmtDay(result.spendThrough))}
                  </p>
                )}
                {result.unlinkedSpend !== null && result.unlinkedSpend > 0 && (
                  <p className="flex items-center gap-1" data-testid="payback-unlinked">
                    {COPY.table.unlinked(fmtMoney(result.unlinkedSpend))}
                    <InfoTip label={COPY.aria.unlinked}>{COPY.table.unlinkedInfo}</InfoTip>
                  </p>
                )}
                {ltv?.range?.capped && <p>{COPY.banner.rangeCapped}</p>}
              </div>
            }
          />
        </Card>
        <PaybackSheet
          row={sheetRow}
          label={sheetRow ? paybackRowLabel(sheetRow.key, names) : ""}
          result={result}
          spend={spend}
          trend={trend}
          onClose={() => update({ open: null })}
        />
      </>
    );
  }

  return (
    <AppLayout title={COPY.page.title} description={COPY.page.description} actions={legacyLink}>
      <TooltipProvider delayDuration={150}>
        <div className="min-w-0 space-y-3">
          <Card className="min-w-0 p-3 shadow-card">
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
              <PaybackFilters
                products={products}
                selectedProducts={selectedProducts}
                onToggleProduct={toggleProduct}
                onClearProducts={() => update({ products: [], funnels: null })}
                funnelOptions={funnelOptions}
                selectedFunnels={selectedFunnelSet}
                onToggleFunnel={toggleFunnel}
                onSelectAllFunnels={() => update({ funnels: null })}
                onClearFunnels={() => update({ funnels: [] })}
                period={state.period}
                fromMonth={customMonths.fromMonth}
                toMonth={customMonths.toMonth}
                maxMonth={today.slice(0, 7)}
                problem={problem}
                onPeriod={onPeriod}
                onCustomMonths={(fromMonth, toMonth) => update({ period: "custom", fromMonth, toMonth })}
              />
              {chips}
            </div>
          </Card>
          {banner && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-xs" role="alert" data-testid="payback-spend-banner">
              <TriangleAlert className="h-4 w-4 shrink-0 text-warning" />
              <span className="min-w-0 flex-1">{banner.text}</span>
              {banner.retry && <Button variant="outline" size="sm" className="h-7 text-xs" onClick={banner.retry}>{COPY.banner.retry}</Button>}
            </div>
          )}
          {result?.trialsCutAt && (
            <p className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground" role="status" data-testid="payback-refreshing">
              <RefreshCw className="h-3.5 w-3.5 shrink-0" />
              {COPY.banner.trialsRefreshing(fmtDay(result.trialsCutAt))}
            </p>
          )}
          {body}
        </div>
      </TooltipProvider>
    </AppLayout>
  );
}
