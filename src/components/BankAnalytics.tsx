// The Banks tab: payment pass rate by card issuer.
//
// Everything here is server-aggregated over the same staged attempt table the
// Payment Pass tab uses — the totals row of this tab and that tab's summary
// must be byte-equal under identical filters, and the coverage card exists so
// the table can never quietly exclude the 7.8% of attempts with no issuer.
//
// This component takes NO txs prop: it reads nothing from the client store.
import { Fragment, useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronRight, Loader2, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { KpiCard } from "@/components/KpiCard";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { usePersistedPageState } from "@/hooks/usePersistedPageState";
import { hashUserScope } from "@/services/analyticsCache";
import { useWarehouseVersion } from "@/hooks/useAnalyticsCache";
import { useBankAnalyticsBundle, useBankDetail } from "@/hooks/useBankAnalyticsCache";
import {
  EMPTY_BANK_QUERY,
  signalBadge,
  volumeBadge,
  VOLUME_BADGE_LABELS,
  type BankAnalyticsQuery,
  type IssuerGroupRow,
  type IssuerRow,
} from "@/services/bankAnalyticsDataSource";
import { issuerGroupLabel, issuerLabel } from "@/services/cardIssuer";
import { cardNetworkLabel, paymentMethodLabel } from "@/services/cardNetwork";
import { DECLINE_REASON_LABELS } from "@/services/paymentPassAnalytics";

const PAGE_SIZE = 25;
const MIN_VOLUME_OPTIONS = [0, 30, 100, 300, 1000] as const;

type SortKey = "issuer_name" | "attempts" | "pass_rate" | "pass_rate_ex_if" | "successful" | "failed"
  | "users_with_attempts" | "first_attempt_pass_rate";

const DEFAULT_UI_STATE = {
  dateFrom: "",
  dateTo: "",
  dateBasis: "transaction" as "transaction" | "cohort",
  funnel: [] as string[],
  issuer: [] as string[],
  issuerGroup: [] as string[],
  cardNetwork: [] as string[],
  paymentMethod: [] as string[],
  issuerCountry: [] as string[],
  groupSubBrands: false,
  minVolume: 100 as (typeof MIN_VOLUME_OPTIONS)[number],
  sortKey: "attempts" as SortKey,
  sortDir: "desc" as "asc" | "desc",
  search: "",
};

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const num = (v: number): string => v.toLocaleString("en-US");

interface MultiOption { value: string; label: string; count?: number }

function MultiSelect({ label, values, options, placeholder, onChange }: {
  label: string; values: string[]; options: MultiOption[]; placeholder: string;
  onChange: (values: string[]) => void;
}) {
  const selected = new Set(values);
  const text = values.length ? `${values.length} selected` : placeholder;
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Popover>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" className="h-9 w-full justify-between px-3 font-normal">
            <span className={cn("truncate", values.length ? "text-foreground" : "text-muted-foreground")}>{text}</span>
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-0">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs font-medium text-muted-foreground">{label}</span>
            {values.length > 0 && (
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onChange([])}>
                Clear
              </Button>
            )}
          </div>
          <div className="max-h-72 overflow-auto p-1">
            {options.length ? options.map((option) => {
              const checked = selected.has(option.value);
              return (
                <button
                  type="button"
                  key={option.value}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
                  onClick={() => onChange(checked ? values.filter((v) => v !== option.value) : [...values, option.value])}
                >
                  <Checkbox checked={checked} className="pointer-events-none" />
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.count != null && <span className="text-xs tabular-nums text-muted-foreground">{num(option.count)}</span>}
                </button>
              );
            }) : (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">No options</div>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function VolumeBadgeChip({ attempts }: { attempts: number }) {
  const badge = volumeBadge(attempts);
  if (!badge) return null;
  const tone = badge === "too_few" ? "text-muted-foreground border-border"
    : badge === "low_volume" ? "text-warning border-warning/40" : "text-foreground border-border";
  return <Badge variant="outline" className={cn("text-[10px] font-normal", tone)}>{VOLUME_BADGE_LABELS[badge]}</Badge>;
}

function SignalChip({ row, accountRate }: { row: { successful: number; attempts: number }; accountRate: number }) {
  const signal = signalBadge(row.successful, row.attempts, accountRate);
  if (!signal) return null;
  return signal === "below_account"
    ? <Badge variant="outline" className="text-[10px] font-normal text-destructive border-destructive/40">Ниже среднего</Badge>
    : <Badge variant="outline" className="text-[10px] font-normal text-success border-success/40">Выше среднего</Badge>;
}

/** Volume-scaled stacked bar: length = attempts share of the max, fill split =
 * success/fail. Communicates sample size visually before any badge does. */
function VolumeBar({ attempts, successful, failed, max }: { attempts: number; successful: number; failed: number; max: number }) {
  return (
    <div className="h-2.5 w-40 overflow-hidden rounded-full bg-muted" title={`${num(attempts)} попыток`}>
      <div className="flex h-full overflow-hidden rounded-full" style={{ width: `${max ? (attempts / max) * 100 : 0}%` }}>
        <div className="bg-primary" style={{ width: `${attempts ? (successful / attempts) * 100 : 0}%` }} />
        <div className="bg-warning" style={{ width: `${attempts ? (failed / attempts) * 100 : 0}%` }} />
      </div>
    </div>
  );
}

const trendConfig = { pass_rate: { label: "Pass Rate", color: "hsl(var(--primary))" } } satisfies ChartConfig;

function BankDetailPanel({ query, issuerKey, userScopeHash, warehouseVersion }: {
  query: BankAnalyticsQuery; issuerKey: string; userScopeHash: string; warehouseVersion: string;
}) {
  const { detail, error, isLoading } = useBankDetail({ query, userScopeHash, warehouseVersion, issuerKey });
  if (isLoading) {
    return <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Загрузка деталей…</div>;
  }
  if (error) return <div className="py-4 text-sm text-destructive">{error}</div>;
  if (!detail) return null;

  const block = (title: string, rows: Array<{ label: string; attempts: number; pass_rate: number }>) => (
    <div>
      <h4 className="mb-1 text-xs font-semibold text-muted-foreground">{title}</h4>
      <div className="space-y-0.5">
        {rows.slice(0, 6).map((r) => (
          <div key={r.label} className="flex items-center justify-between gap-3 text-xs">
            <span className="min-w-0 truncate">{r.label}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{num(r.attempts)} · {pct(r.pass_rate)}</span>
          </div>
        ))}
        {!rows.length && <div className="text-xs text-muted-foreground">—</div>}
      </div>
    </div>
  );

  return (
    <div className="grid gap-4 py-3 md:grid-cols-2 lg:grid-cols-4">
      {block("По стадиям", detail.stage_rows.map((r) => ({ label: r.stage, attempts: r.attempts, pass_rate: r.pass_rate })))}
      {block("По странам пользователя", detail.country_rows.map((r) => ({ label: r.country || "unknown", attempts: r.attempts, pass_rate: r.pass_rate })))}
      {block("По сетям и способам", [
        ...detail.network_rows.map((r) => ({ label: cardNetworkLabel(r.card_network), attempts: r.attempts, pass_rate: r.pass_rate })),
        ...detail.method_rows.map((r) => ({ label: paymentMethodLabel(r.payment_method), attempts: r.attempts, pass_rate: r.pass_rate })),
      ])}
      <div>
        <h4 className="mb-1 text-xs font-semibold text-muted-foreground">Причины отказов</h4>
        <div className="space-y-0.5">
          {detail.decline_rows.slice(0, 6).map((r) => (
            <div key={r.reason} className="flex items-center justify-between gap-3 text-xs">
              <span className="min-w-0 truncate">{DECLINE_REASON_LABELS[r.reason as keyof typeof DECLINE_REASON_LABELS] ?? r.reason}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{num(r.failed_attempts)} · {pct(r.share_of_failed)}</span>
            </div>
          ))}
          {!detail.decline_rows.length && <div className="text-xs text-muted-foreground">—</div>}
        </div>
        {detail.group_members.length > 1 && (
          <div className="mt-2 text-xs text-muted-foreground">
            В группе: {detail.group_members.map((m) => m.issuer_name).join(", ")}
          </div>
        )}
      </div>
    </div>
  );
}

export function BankAnalytics() {
  const { user } = useAuth();
  const userScopeHash = useMemo(() => hashUserScope(user?.id), [user?.id]);
  const { version: warehouseVersion, ready: warehouseVersionReady } = useWarehouseVersion(true);
  const [uiState, setUiState] = usePersistedPageState("ui_state_transactions_banks", DEFAULT_UI_STATE);
  const update = (patch: Partial<typeof DEFAULT_UI_STATE>) => setUiState((cur) => ({ ...cur, ...patch }));
  const [page, setPage] = useState(1);
  const [expandedIssuer, setExpandedIssuer] = useState<string | null>(null);

  const query = useMemo<BankAnalyticsQuery>(() => ({
    ...EMPTY_BANK_QUERY,
    dateBasis: uiState.dateBasis,
    dateFrom: uiState.dateFrom || null,
    dateTo: uiState.dateTo || null,
    funnel: uiState.funnel,
    issuer: uiState.issuer,
    issuerGroup: uiState.issuerGroup,
    cardNetwork: uiState.cardNetwork,
    paymentMethod: uiState.paymentMethod,
    issuerCountry: uiState.issuerCountry,
  }), [uiState.dateBasis, uiState.dateFrom, uiState.dateTo, uiState.funnel, uiState.issuer, uiState.issuerGroup, uiState.cardNetwork, uiState.paymentMethod, uiState.issuerCountry]);

  const { bundle, error, isFetching, isInitialLoading } = useBankAnalyticsBundle({
    query, userScopeHash, warehouseVersion,
    enabled: Boolean(user?.id) && warehouseVersionReady,
  });

  const accountRate = bundle?.totals.pass_rate ?? 0;

  // --- table state ----------------------------------------------------------
  const toggleSort = (key: SortKey) => {
    if (uiState.sortKey === key) update({ sortDir: uiState.sortDir === "asc" ? "desc" : "asc" });
    else update({ sortKey: key, sortDir: key === "issuer_name" ? "asc" : "desc" });
    setPage(1);
  };
  const sortIcon = (key: SortKey) =>
    uiState.sortKey !== key ? <ArrowUpDown className="h-3 w-3 opacity-40" />
      : uiState.sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;

  // Grouping swaps the row source; both aggregations arrived in one response,
  // so the toggle is instant and user counts stay exact in both modes.
  const activeRows = useMemo<IssuerRow[]>(() => {
    if (!bundle) return [];
    if (!uiState.groupSubBrands) return bundle.issuer_rows;
    return bundle.issuer_group_rows.map((g: IssuerGroupRow): IssuerRow => ({
      ...g,
      issuer_key: g.issuer_group,
      issuer_name: issuerGroupLabel(g.issuer_group),
      issuer_group: g.issuer_group,
    }));
  }, [bundle, uiState.groupSubBrands]);

  const { visible, othersRow, othersCount } = useMemo(() => {
    const q = uiState.search.trim().toLowerCase();
    let rows = activeRows.filter((r) => r.issuer_key !== "" && r.issuer_key !== "unknown");
    if (q) rows = rows.filter((r) => r.issuer_name.toLowerCase().includes(q) || r.issuer_key.includes(q));

    const above = rows.filter((r) => r.attempts >= uiState.minVolume);
    const below = rows.filter((r) => r.attempts < uiState.minVolume);

    const dir = uiState.sortDir === "asc" ? 1 : -1;
    const key = uiState.sortKey;
    above.sort((a, b) => {
      const av = key === "issuer_name" ? a.issuer_name : a[key];
      const bv = key === "issuer_name" ? b.issuer_name : b[key];
      if (typeof av === "string" && typeof bv === "string") return av.localeCompare(bv) * dir;
      return ((av as number) - (bv as number)) * dir || a.issuer_name.localeCompare(b.issuer_name);
    });

    // Sub-threshold rows collapse into one pinned footer row: attempts sum
    // exactly; user counts are labelled "≤" because uniqExact is not additive.
    const others = below.length ? {
      attempts: below.reduce((acc, r) => acc + r.attempts, 0),
      successful: below.reduce((acc, r) => acc + r.successful, 0),
      failed: below.reduce((acc, r) => acc + r.failed, 0),
      users: below.reduce((acc, r) => acc + r.users_with_attempts, 0),
    } : null;

    return { visible: above, othersRow: others, othersCount: below.length };
  }, [activeRows, uiState.search, uiState.minVolume, uiState.sortKey, uiState.sortDir]);

  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paged = visible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const maxAttempts = Math.max(1, ...visible.map((r) => r.attempts));

  // KPI derivations
  const meaningful = useMemo(() => visible.filter((r) => r.attempts >= 300), [visible]);
  const worst = useMemo(() => [...meaningful].sort((a, b) => (a.failed * (1 - a.pass_rate)) < (b.failed * (1 - b.pass_rate)) ? 1 : -1)[0] ?? null, [meaningful]);
  const best = useMemo(() => [...meaningful].sort((a, b) => b.pass_rate - a.pass_rate)[0] ?? null, [meaningful]);

  const coverage = bundle?.coverage ?? null;
  const identifiedShare = coverage && coverage.total_attempts > 0
    ? coverage.identified_attempts / coverage.total_attempts : 0;

  // Trend: pivot points into per-day rows of top-issuer pass rates.
  const trendData = useMemo(() => {
    if (!bundle) return { rows: [] as Array<Record<string, unknown>>, keys: [] as string[] };
    const keys = Array.from(new Set(bundle.trend_points.map((p) => p.issuer_key))).slice(0, 8);
    const byDate = new Map<string, Record<string, unknown>>();
    for (const p of bundle.trend_points) {
      if (!keys.includes(p.issuer_key)) continue;
      const row = byDate.get(p.date) ?? { date: p.date };
      row[p.issuer_key] = p.attempts > 0 ? Number(((p.successful / p.attempts) * 100).toFixed(1)) : null;
      byDate.set(p.date, row);
    }
    return { rows: Array.from(byDate.values()).sort((a, b) => String(a.date) < String(b.date) ? -1 : 1), keys };
  }, [bundle]);

  const issuerNameOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of bundle?.issuer_rows ?? []) map.set(r.issuer_key, r.issuer_name);
    return map;
  }, [bundle]);

  if (isInitialLoading) {
    return (
      <Card className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Загрузка банковской аналитики…
      </Card>
    );
  }
  if (error && !bundle) {
    return (
      <Card className="p-6 text-sm">
        <div className="font-medium text-destructive">Банковская аналитика недоступна</div>
        <p className="mt-1 text-muted-foreground">{error}</p>
        <p className="mt-2 text-xs text-muted-foreground">
          Вкладка работает только на серверном пути ClickHouse. Если колонки эмитента ещё не заполнены —
          запустите Initialize schema и Full backfill на странице Integrations.
        </p>
      </Card>
    );
  }
  if (!bundle || !coverage) return null;

  const filterOptions = bundle.filter_options;

  return (
    <div className="space-y-4">
      {/* KPI strip */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <KpiCard label="Проходимость" value={pct(bundle.totals.pass_rate)} hint={`${num(bundle.totals.attempts)} попыток`} />
        <KpiCard label="Банков в анализе" value={String(visible.length)} hint={`из ${num(activeRows.filter((r) => r.issuer_key && r.issuer_key !== "unknown").length)} опознанных`} />
        <KpiCard label="Покрытие эмитента" value={pct(identifiedShare)} hint={`${num(coverage.identified_attempts)} из ${num(coverage.total_attempts)}`} />
        <KpiCard label="Худший значимый" value={worst ? pct(worst.pass_rate) : "—"} hint={worst?.issuer_name ?? "нет банков с ≥300 попыток"} />
        <KpiCard label="Лучший значимый" value={best ? pct(best.pass_rate) : "—"} hint={best?.issuer_name ?? "нет банков с ≥300 попыток"} />
      </div>

      {/* Coverage card — what makes the tab trustworthy */}
      <Card className="p-4 text-sm">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
          <span className="font-medium">Покрытие</span>
          <span>Опознано: <span className="tabular-nums">{num(coverage.identified_attempts)}</span> ({pct(coverage.total_attempts ? coverage.identified_attempts / coverage.total_attempts : 0)})</span>
          <span>Провайдер ответил «UNKNOWN»: <span className="tabular-nums">{num(coverage.reported_unknown_attempts)}</span></span>
          <span>Не сообщено: <span className="tabular-nums">{num(coverage.missing_attempts)}</span></span>
          {isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Покрытие на успехах {coverage.identified_success + coverage.unidentified_success > 0
            ? pct(coverage.identified_success / (coverage.identified_success + coverage.unidentified_success)) : "—"}
          {" "}против {coverage.identified_failed + coverage.unidentified_failed > 0
            ? pct(coverage.identified_failed / (coverage.identified_failed + coverage.unidentified_failed)) : "—"} на отказах — смещения по исходу нет.
          {" "}3-D Secure на этом трафике не выполняется (NOT_PERFORMED), поэтому 3DS-метрик здесь нет.
        </p>
        {coverage.non_attempt_rows > 0 && (
          <p className="mt-1 text-xs text-warning">
            {num(coverage.non_attempt_rows)} строк не являются ни успехом, ни отказом — они разбавляют знаменатель. Проверьте источник.
          </p>
        )}
      </Card>

      {/* Filters */}
      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Дата с</Label>
            <Input type="date" className="h-9" value={uiState.dateFrom} onChange={(e) => { update({ dateFrom: e.target.value }); setPage(1); }} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Дата по</Label>
            <Input type="date" className="h-9" value={uiState.dateTo} onChange={(e) => { update({ dateTo: e.target.value }); setPage(1); }} />
          </div>
          <MultiSelect label="Банк" placeholder="Все банки"
            values={uiState.issuer}
            options={filterOptions.issuer.map((o) => ({ value: o.issuer_key, label: o.issuer_name, count: o.attempts }))}
            onChange={(v) => { update({ issuer: v }); setPage(1); }} />
          <MultiSelect label="Группа" placeholder="Все группы"
            values={uiState.issuerGroup}
            options={filterOptions.issuer_group.map((o) => ({ value: o.issuer_group, label: issuerGroupLabel(o.issuer_group), count: o.attempts }))}
            onChange={(v) => { update({ issuerGroup: v }); setPage(1); }} />
          <MultiSelect label="Сеть" placeholder="Все сети"
            values={uiState.cardNetwork}
            options={filterOptions.card_network.map((v) => ({ value: v, label: cardNetworkLabel(v) }))}
            onChange={(v) => { update({ cardNetwork: v }); setPage(1); }} />
          <MultiSelect label="Способ оплаты" placeholder="Все способы"
            values={uiState.paymentMethod}
            options={filterOptions.payment_method.map((v) => ({ value: v, label: paymentMethodLabel(v) }))}
            onChange={(v) => { update({ paymentMethod: v }); setPage(1); }} />
          <MultiSelect label="Страна банка" placeholder="Все страны"
            values={uiState.issuerCountry}
            options={filterOptions.issuer_country.map((v) => ({ value: v, label: v }))}
            onChange={(v) => { update({ issuerCountry: v }); setPage(1); }} />
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Мин. попыток</Label>
            <Select value={String(uiState.minVolume)} onValueChange={(v) => { update({ minVolume: Number(v) as typeof uiState.minVolume }); setPage(1); }}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {MIN_VOLUME_OPTIONS.map((v) => (
                  <SelectItem key={v} value={String(v)}>{v === 0 ? "Все" : `≥ ${v}`}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end gap-2 pb-1">
            <Switch id="group-subbrands" checked={uiState.groupSubBrands}
              onCheckedChange={(v) => { update({ groupSubBrands: v }); setPage(1); setExpandedIssuer(null); }} />
            <Label htmlFor="group-subbrands" className="text-xs">Свернуть суб-бренды</Label>
          </div>
          <div className="relative flex items-end">
            <Search className="absolute left-2.5 bottom-2.5 h-4 w-4 text-muted-foreground" />
            <Input className="h-9 pl-8" placeholder="Поиск банка…" value={uiState.search}
              onChange={(e) => { update({ search: e.target.value }); setPage(1); }} />
          </div>
        </div>
      </Card>

      {/* Trend */}
      {trendData.rows.length > 1 && (
        <Card className="p-4 shadow-card">
          <h3 className="mb-3 text-sm font-semibold">Проходимость по дням — топ банков по объёму</h3>
          <ChartContainer config={trendConfig} className="h-[260px] w-full">
            <LineChart data={trendData.rows} margin={{ left: 8, right: 16, top: 8, bottom: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} hide={trendData.rows.length > 20} />
              <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={(v) => `${v}%`} />
              <ChartTooltip content={<ChartTooltipContent />} />
              {trendData.keys.map((key, i) => (
                <Line key={key} type="monotone" dataKey={key} name={issuerNameOf.get(key) ?? key}
                  stroke={`hsl(${(i * 47) % 360} 60% 45%)`} strokeWidth={1.5} dot={false} connectNulls />
              ))}
            </LineChart>
          </ChartContainer>
        </Card>
      )}

      {/* Main table */}
      <Card className="p-0 shadow-card">
        <div className="flex items-center justify-between border-b border-border p-4">
          <div>
            <h3 className="text-sm font-semibold">Банки-эмитенты</h3>
            <p className="text-xs text-muted-foreground">
              {num(visible.length)} банков ≥ {uiState.minVolume || 0} попыток · страница {safePage} из {totalPages}
              {bundle.truncated && <span className="text-warning"> · список усечён сервером</span>}
            </p>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={safePage <= 1}>Previous</Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={safePage >= totalPages}>Next</Button>
          </div>
        </div>
        <div className="overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <button type="button" className="inline-flex items-center gap-1 font-medium hover:text-foreground" onClick={() => toggleSort("issuer_name")}>
                    Банк {sortIcon("issuer_name")}
                  </button>
                </TableHead>
                <TableHead className="text-right">
                  <button type="button" className="inline-flex items-center gap-1 font-medium hover:text-foreground" onClick={() => toggleSort("attempts")}>
                    Попытки {sortIcon("attempts")}
                  </button>
                </TableHead>
                <TableHead>Объём</TableHead>
                <TableHead className="text-right">
                  <button type="button" className="inline-flex items-center gap-1 font-medium hover:text-foreground" onClick={() => toggleSort("pass_rate")}>
                    Проходимость {sortIcon("pass_rate")}
                  </button>
                </TableHead>
                <TableHead className="text-right">
                  <button type="button" className="inline-flex items-center gap-1 font-medium hover:text-foreground" onClick={() => toggleSort("pass_rate_ex_if")}>
                    Без IF {sortIcon("pass_rate_ex_if")}
                  </button>
                </TableHead>
                <TableHead className="text-right">
                  <button type="button" className="inline-flex items-center gap-1 font-medium hover:text-foreground" onClick={() => toggleSort("successful")}>
                    Успешно {sortIcon("successful")}
                  </button>
                </TableHead>
                <TableHead className="text-right">
                  <button type="button" className="inline-flex items-center gap-1 font-medium hover:text-foreground" onClick={() => toggleSort("failed")}>
                    Отказы {sortIcon("failed")}
                  </button>
                </TableHead>
                <TableHead className="text-right">
                  <button type="button" className="inline-flex items-center gap-1 font-medium hover:text-foreground" onClick={() => toggleSort("users_with_attempts")}>
                    Польз. {sortIcon("users_with_attempts")}
                  </button>
                </TableHead>
                <TableHead className="text-right">
                  <button type="button" className="inline-flex items-center gap-1 font-medium hover:text-foreground" onClick={() => toggleSort("first_attempt_pass_rate")}>
                    1-я попытка {sortIcon("first_attempt_pass_rate")}
                  </button>
                </TableHead>
                <TableHead>Гл. причина отказа</TableHead>
                <TableHead>Сигнал</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paged.map((row) => {
                const expanded = expandedIssuer === row.issuer_key;
                const muted = row.attempts < 30;
                return (
                  <Fragment key={row.issuer_key}>
                    <TableRow className="cursor-pointer hover:bg-muted/40"
                      onClick={() => setExpandedIssuer(expanded ? null : row.issuer_key)}>
                      <TableCell className="font-medium">
                        <span className="inline-flex items-center gap-1.5">
                          {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                          <span className="max-w-[260px] truncate">{issuerLabel(row.issuer_key, row.issuer_name)}</span>
                          {!uiState.groupSubBrands && row.issuer_group !== row.issuer_key && (
                            <Badge variant="secondary" className="text-[10px] font-normal">{issuerGroupLabel(row.issuer_group)}</Badge>
                          )}
                          <VolumeBadgeChip attempts={row.attempts} />
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{num(row.attempts)}</TableCell>
                      <TableCell><VolumeBar attempts={row.attempts} successful={row.successful} failed={row.failed} max={maxAttempts} /></TableCell>
                      <TableCell className={cn("text-right tabular-nums", muted && "text-muted-foreground")}>
                        {muted ? `~${pct(row.pass_rate)}` : pct(row.pass_rate)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{pct(row.pass_rate_ex_if)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(row.successful)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(row.failed)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(row.users_with_attempts)}</TableCell>
                      <TableCell className="text-right tabular-nums">{pct(row.first_attempt_pass_rate)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {row.top_decline_reason
                          ? `${DECLINE_REASON_LABELS[row.top_decline_reason as keyof typeof DECLINE_REASON_LABELS] ?? row.top_decline_reason} · ${num(row.top_decline_reason_users)}`
                          : "—"}
                      </TableCell>
                      <TableCell><SignalChip row={row} accountRate={accountRate} /></TableCell>
                    </TableRow>
                    {expanded && !uiState.groupSubBrands && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={11} className="bg-muted/20 px-6">
                          <BankDetailPanel query={query} issuerKey={row.issuer_key}
                            userScopeHash={userScopeHash} warehouseVersion={warehouseVersion} />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
              {othersRow && (
                <TableRow className="hover:bg-transparent">
                  <TableCell className="text-muted-foreground">
                    Прочие ({num(othersCount)} банков ниже порога)
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{num(othersRow.attempts)}</TableCell>
                  <TableCell />
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {othersRow.attempts ? pct(othersRow.successful / othersRow.attempts) : "—"}
                  </TableCell>
                  <TableCell />
                  <TableCell className="text-right tabular-nums text-muted-foreground">{num(othersRow.successful)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{num(othersRow.failed)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground"
                    title="Сумма uniqExact по банкам переоценивает: один пользователь мог платить картами разных банков.">
                    ≤{num(othersRow.users)}
                  </TableCell>
                  <TableCell colSpan={3} />
                </TableRow>
              )}
              {!paged.length && !othersRow && (
                <TableRow>
                  <TableCell colSpan={11} className="h-24 text-center text-sm text-muted-foreground">
                    Нет банков под текущим фильтром.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  );
}
