// Weekly reports (R5).
//
// Two screens in one route: the list of saved reports, and the report itself.
// The report shown here is entirely deterministic — KPI table with deltas and
// targets, funnel blocks with their passports and rule-engine statuses. No AI
// is involved at this phase, and the page is designed so that stays true: the
// prose blocks arriving in R9 sit alongside these tables, never instead of them.
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, ClipboardCopy, Download, FileText, Loader2, Plus, Printer, RefreshCw, Save } from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { REPORT_ENGINE_VERSION, REPORT_SCHEMA_VERSION, emptyReportBindings } from "@/services/reportContract";
import type {
  Report, ReportListItem, ReportMetric, ReportSnapshot, ReportFunnelRow,
} from "@/services/reportContract";
import {
  listReports, loadReport, newReport, publishReport, saveReport,
} from "@/services/reports";
import { collectReport, lastCompletedWeek, weekWindows } from "@/services/reportCollect";
import { UNAVAILABLE_RENDER } from "@/services/reportBuilder";
import type { Finding } from "@/services/reportRules";
import { COHORT_CLASSIFICATION_VERSION } from "../../supabase/functions/_shared/clickhouse/cohortMembership";
import { FX_RATES_AS_OF } from "@/services/fxRates";
import { PlanFactPanel } from "@/components/reports/PlanFactPanel";
import {
  copyReportForDocs, downloadReportMarkdown, printReport, type RenderInput,
} from "@/services/reportExport";
import type { ReportTask } from "@/services/reportContract";

const STATUS_LABELS: Record<string, string> = {
  scale: "Масштабировать",
  continue_testing: "Продолжать тест",
  needs_optimization: "Требует оптимизации",
  reduce_budget: "Снизить бюджет",
  pause: "Пауза",
  insufficient_data: "Мало данных",
};

const STATUS_TONE: Record<string, string> = {
  scale: "text-success border-success/40",
  continue_testing: "text-foreground border-border",
  needs_optimization: "text-warning border-warning/40",
  reduce_budget: "text-warning border-warning/40",
  pause: "text-destructive border-destructive/40",
  insufficient_data: "text-muted-foreground border-border",
};

function engineVersions() {
  return {
    report: REPORT_ENGINE_VERSION,
    cohortClassification: COHORT_CLASSIFICATION_VERSION,
    funnelEconomics: "1.0.0",
    supportClassification: "support_llm_v2",
    fxRatesAsOf: FX_RATES_AS_OF,
  };
}

/** Delta cell. Colour follows `better`, not direction: a falling CPA is green
 * and a falling trial count is red, and the engine has already decided which. */
function DeltaCell({ metric }: { metric: ReportMetric }) {
  const delta = metric.delta;
  if (!delta) return <span className="text-muted-foreground/40">{UNAVAILABLE_RENDER}</span>;
  const tone = delta.better === null
    ? "text-muted-foreground"
    : delta.better ? "text-success" : "text-destructive";
  return (
    <span className={tone} title={delta.significant ? "Значимое изменение" : "В пределах шума или выборка мала"}>
      {delta.absoluteRendered}
      <span className="ml-1 text-xs opacity-70">{delta.percentRendered}</span>
      {!delta.significant && <span className="ml-1 text-xs opacity-50">·</span>}
    </span>
  );
}

function MetricValue({ metric }: { metric: ReportMetric }) {
  if (metric.current.value === null) {
    return (
      <span className="text-muted-foreground/60" title={metric.current.unavailable?.detail}>
        {UNAVAILABLE_RENDER}
      </span>
    );
  }
  return <span className="tabular-nums">{metric.current.rendered}</span>;
}

function KpiTable({ snapshot }: { snapshot: ReportSnapshot }) {
  const rows = Object.values(snapshot.kpi);
  return (
    <Card className="p-0 shadow-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Показатель</TableHead>
            <TableHead className="text-right">Период</TableHead>
            <TableHead className="text-right">Прошлый</TableHead>
            <TableHead className="text-right">Изменение</TableHead>
            <TableHead className="text-right">Цель</TableHead>
            <TableHead className="text-right">Выборка</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((metric) => (
            <TableRow key={metric.key}>
              <TableCell className="font-medium">{metric.label}</TableCell>
              <TableCell className="text-right"><MetricValue metric={metric} /></TableCell>
              <TableCell className="text-right text-muted-foreground tabular-nums">
                {metric.delta?.previousRendered ?? UNAVAILABLE_RENDER}
              </TableCell>
              <TableCell className="text-right tabular-nums"><DeltaCell metric={metric} /></TableCell>
              <TableCell className="text-right text-xs">
                {metric.target ? (
                  <span className={metric.target.met === null ? "text-muted-foreground"
                    : metric.target.met ? "text-success" : "text-warning"}>
                    {metric.target.rendered}
                  </span>
                ) : <span className="text-muted-foreground/40">{UNAVAILABLE_RENDER}</span>}
              </TableCell>
              <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
                {metric.sampleSize ?? UNAVAILABLE_RENDER}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function PassportLine({ funnel }: { funnel: ReportFunnelRow }) {
  const p = funnel.passport;
  if (p.incomplete) {
    return (
      <p className="text-xs text-warning">
        Паспорт не заполнен — заполните его на странице Funnels, иначе блок остаётся без шапки,
        а конверсия по этой воронке не считается.
      </p>
    );
  }
  const parts: string[] = [];
  if (p.trialPrice !== null) {
    parts.push(`Триал: ${p.trialPrice}${p.trialCurrency ?? "$"}${p.trialDurationDays !== null ? ` длительностью ${p.trialDurationDays} дн.` : ""}`);
  }
  if (p.subscriptionPrice !== null) {
    parts.push(`Тариф: ${p.subscriptionPrice}${p.subscriptionCurrency ?? "$"}${p.billingPeriod ? ` (${p.billingPeriod})` : ""}`);
  }
  if (p.upsells.length) {
    parts.push(p.upsells.map((u, i) => `Апсейл ${i + 1} ${u.name}${u.price !== null ? ` ${u.price}$` : ""}`).join(" | "));
  }
  if (p.geoLocalization.length) parts.push(`Локализация: ${p.geoLocalization.join(", ")}`);
  return <p className="text-xs text-muted-foreground">{parts.join(" · ")}</p>;
}

function FunnelBlock({ funnel }: { funnel: ReportFunnelRow }) {
  const metrics = Object.values(funnel.metrics);
  return (
    <Card className="space-y-2 p-4 shadow-card">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-medium">{funnel.funnelPath}</span>
        {funnel.isNew && <Badge variant="secondary" className="text-xs font-normal">новая</Badge>}
        <Badge
          variant="outline"
          className={`text-xs font-normal ${STATUS_TONE[funnel.status.status] ?? ""}`}
          title={funnel.status.because}
        >
          {STATUS_LABELS[funnel.status.status] ?? funnel.status.status}
        </Badge>
      </div>
      <PassportLine funnel={funnel} />
      <p className="text-xs text-muted-foreground/80">{funnel.status.because}</p>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {metrics.map((metric) => (
                <TableHead key={metric.key} className="text-right text-xs">{metric.label}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              {metrics.map((metric) => (
                <TableCell key={metric.key} className="text-right tabular-nums">
                  <MetricValue metric={metric} />
                  {metric.delta && (
                    <div className="text-xs"><DeltaCell metric={metric} /></div>
                  )}
                </TableCell>
              ))}
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}

function Highlights({ findings }: { findings: Finding[] }) {
  if (!findings.length) {
    return <p className="text-sm text-muted-foreground">Правила не нашли изменений, достойных отдельного пункта.</p>;
  }
  return (
    <ul className="space-y-1.5">
      {findings.map((finding) => (
        <li key={finding.id} className="flex gap-2 text-sm">
          <span className={
            finding.polarity === "good" ? "text-success"
              : finding.polarity === "bad" ? "text-destructive" : "text-muted-foreground"
          }>•</span>
          <span>{finding.claim}</span>
        </li>
      ))}
    </ul>
  );
}

function DataQualityPanel({ snapshot }: { snapshot: ReportSnapshot }) {
  if (!snapshot.dataIncomplete && !snapshot.gaps.length) return null;
  return (
    <Card className="space-y-2 border-warning/40 bg-warning/5 p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-warning">
        <AlertTriangle className="h-4 w-4" /> Чего не хватает в данных
      </div>
      {snapshot.provisionalReasons.length > 0 && (
        <ul className="ml-5 list-disc space-y-0.5 text-xs">
          {snapshot.provisionalReasons.map((reason) => <li key={reason}>{reason}</li>)}
        </ul>
      )}
      {snapshot.gaps.length > 0 && (
        <ul className="ml-5 list-disc space-y-0.5 text-xs text-muted-foreground">
          {snapshot.gaps.map((gap) => <li key={gap.key}><span className="font-medium">{gap.label}</span> — {gap.reason}</li>)}
        </ul>
      )}
    </Card>
  );
}

export default function ReportsPage() {
  const { toast } = useToast();
  const [items, setItems] = useState<ReportListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<Report | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [highlights, setHighlights] = useState<Finding[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [tasks, setTasks] = useState<{ closed: ReportTask[]; open: ReportTask[] }>({ closed: [], open: [] });

  const defaultWeek = useMemo(() => lastCompletedWeek(new Date().toISOString().slice(0, 10)), []);
  const [from, setFrom] = useState(defaultWeek.period.from);
  const [to, setTo] = useState(defaultWeek.period.to);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await listReports());
    } catch (error) {
      toast({
        title: "Не удалось загрузить отчёты",
        description: error instanceof Error ? error.message : "Неизвестная ошибка",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function onCreate() {
    setBusy("create");
    try {
      const period = { from, to };
      // weekWindows(from), not lastCompletedWeek(from): the latter first steps
      // back a week and would hand us the week BEFORE the one we want to
      // compare against.
      const compare = weekWindows(from).compare;
      const bindings = { ...emptyReportBindings(period, compare) };
      const now = new Date().toISOString();
      const collected = await collectReport({ bindings, engineVersions: engineVersions(), now });

      const draft = newReport({
        title: `Отчёт ${period.from} — ${period.to}`,
        bindings,
        engineVersions: engineVersions(),
      });
      draft.snapshot = collected.snapshot;
      draft.status = "collected";
      draft.resolvedAt = now;
      draft.dataIncomplete = collected.snapshot.dataIncomplete;
      draft.provisionalReasons = collected.snapshot.provisionalReasons;

      const id = await saveReport(draft);
      const saved = await loadReport(id);
      setOpen(saved);
      setFindings(collected.findings);
      setHighlights(collected.highlights);
      await refresh();
    } catch (error) {
      toast({
        title: "Не удалось собрать отчёт",
        description: error instanceof Error ? error.message : "Неизвестная ошибка",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  }

  async function onOpen(id: string) {
    setBusy(id);
    try {
      const report = await loadReport(id);
      setOpen(report);
      // Findings are derived, never stored: re-running the rules over the FROZEN
      // snapshot keeps them in step with the engine without touching the data
      // the report was published with.
      if (report.snapshot) {
        const { evaluateRules, rankFindings } = await import("@/services/reportRules");
        const found = evaluateRules(report.snapshot);
        setFindings(found);
        setHighlights(rankFindings(found));
      }
    } catch (error) {
      toast({
        title: "Не удалось открыть отчёт",
        description: error instanceof Error ? error.message : "Неизвестная ошибка",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  }

  async function onRecollect() {
    if (!open) return;
    setBusy("recollect");
    try {
      const now = new Date().toISOString();
      const collected = await collectReport({
        bindings: open.bindings, engineVersions: engineVersions(), now,
      });
      const next: Report = {
        ...open,
        snapshot: collected.snapshot,
        resolvedAt: now,
        dataIncomplete: collected.snapshot.dataIncomplete,
        provisionalReasons: collected.snapshot.provisionalReasons,
      };
      await saveReport(next);
      setOpen(next);
      setFindings(collected.findings);
      setHighlights(collected.highlights);
      await refresh();
    } catch (error) {
      toast({
        title: "Не удалось пересобрать",
        description: error instanceof Error ? error.message : "Неизвестная ошибка",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  }

  async function onPublish() {
    if (!open?.id) return;
    setBusy("publish");
    try {
      const versionNo = await publishReport(open.id);
      toast({ title: `Опубликована версия ${versionNo}`, description: "Данные этой версии больше не изменятся." });
      setOpen(await loadReport(open.id));
      await refresh();
    } catch (error) {
      toast({
        title: "Не удалось опубликовать",
        description: error instanceof Error ? error.message : "Неизвестная ошибка",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  }

  function renderInput(): RenderInput | null {
    if (!open?.snapshot) return null;
    return {
      title: open.title,
      snapshot: open.snapshot,
      blocks: open.blocks,
      highlights: highlights.map((finding) => finding.claim),
      tasks,
    };
  }

  async function onCopyForDocs() {
    const payload = renderInput();
    if (!payload) return;
    try {
      await copyReportForDocs(payload);
      toast({ title: "Скопировано", description: "Вставьте в Google Docs — таблицы и заголовки сохранятся." });
    } catch (error) {
      toast({
        title: "Не удалось скопировать",
        description: error instanceof Error ? error.message : "Неизвестная ошибка",
        variant: "destructive",
      });
    }
  }

  if (open) {
    const snapshot = open.snapshot;
    return (
      <AppLayout
        title="Reports"
        description={`${open.period.from} — ${open.period.to}`}
        actions={
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(null)}>
              <ArrowLeft className="h-4 w-4" /> К списку
            </Button>
            <Button type="button" variant="outline" size="sm"
              onClick={() => void onRecollect()} disabled={busy !== null}>
              {busy === "recollect" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Пересобрать
            </Button>
            <Button type="button" variant="outline" size="sm" title="Скопировать для Google Docs"
              onClick={() => void onCopyForDocs()} disabled={!snapshot}>
              <ClipboardCopy className="h-4 w-4" />
            </Button>
            <Button type="button" variant="outline" size="sm" title="Печать / PDF"
              onClick={() => { const p = renderInput(); if (p) printReport(p); }} disabled={!snapshot}>
              <Printer className="h-4 w-4" />
            </Button>
            <Button type="button" variant="outline" size="sm" title="Скачать Markdown"
              onClick={() => { const p = renderInput(); if (p) downloadReportMarkdown(p); }} disabled={!snapshot}>
              <Download className="h-4 w-4" />
            </Button>
            <Button type="button" size="sm" onClick={() => void onPublish()} disabled={busy !== null || !snapshot}>
              {busy === "publish" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Опубликовать
            </Button>
          </div>
        }
      >
        {!snapshot ? (
          <Card className="p-6 text-sm text-muted-foreground">
            Данные ещё не собраны. Нажмите «Пересобрать».
          </Card>
        ) : (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>Собрано: {new Date(snapshot.collectedAt).toLocaleString()}</span>
              {open.publishedVersionNo !== null && (
                <Badge variant="secondary" className="text-xs font-normal">
                  версия {open.publishedVersionNo}
                </Badge>
              )}
              {!snapshot.consistent && (
                <Badge variant="outline" className="text-xs font-normal text-warning">
                  склад обновился во время сбора
                </Badge>
              )}
            </div>

            <DataQualityPanel snapshot={snapshot} />

            <section className="space-y-2">
              <h2 className="text-sm font-semibold">Главное за неделю</h2>
              <Card className="p-4"><Highlights findings={highlights} /></Card>
            </section>

            <section className="space-y-2">
              <h2 className="text-sm font-semibold">Ключевые показатели недели</h2>
              <KpiTable snapshot={snapshot} />
            </section>

            <section className="space-y-2">
              <h2 className="text-sm font-semibold">
                Результаты по воронкам <span className="text-muted-foreground">({snapshot.funnels.length})</span>
              </h2>
              <div className="space-y-3">
                {snapshot.funnels.map((funnel) => (
                  <FunnelBlock key={funnel.funnelPath} funnel={funnel} />
                ))}
              </div>
            </section>

            <section className="space-y-2">
              <h2 className="text-sm font-semibold">План / Факт и задачи на следующую неделю</h2>
              <PlanFactPanel period={open.period} reportId={open.id} onTasksChange={setTasks} />
            </section>

            {findings.length > highlights.length && (
              <section className="space-y-2">
                <h2 className="text-sm font-semibold">
                  Все находки правил <span className="text-muted-foreground">({findings.length})</span>
                </h2>
                <Card className="p-4"><Highlights findings={findings} /></Card>
              </section>
            )}
          </div>
        )}
      </AppLayout>
    );
  }

  return (
    <AppLayout title="Reports" description="Еженедельные управленческие отчёты">
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="r-from" className="text-xs text-muted-foreground">Период с</Label>
            <Input id="r-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 w-[150px]" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="r-to" className="text-xs text-muted-foreground">по</Label>
            <Input id="r-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 w-[150px]" />
          </div>
          <Button type="button" onClick={() => void onCreate()} disabled={busy !== null}>
            {busy === "create" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Собрать отчёт
          </Button>
          <span className="text-xs text-muted-foreground">
            По умолчанию — прошедшая неделя, сравнение с предыдущей.
          </span>
        </div>
      </Card>

      <Card className="mt-4 p-0 shadow-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Отчёт</TableHead>
              <TableHead>Период</TableHead>
              <TableHead className="text-right">Триалы</TableHead>
              <TableHead className="text-right">Spend</TableHead>
              <TableHead className="text-right">CPA</TableHead>
              <TableHead>Статус</TableHead>
              <TableHead className="text-right">Обновлён</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length ? items.map((item) => (
              <TableRow key={item.id} className="cursor-pointer hover:bg-muted/40"
                onClick={() => void onOpen(item.id)}>
                <TableCell className="font-medium">
                  {item.title}
                  {item.dataIncomplete && (
                    <Badge variant="outline" className="ml-2 text-xs font-normal text-warning">неполные данные</Badge>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{item.periodFrom} — {item.periodTo}</TableCell>
                <TableCell className="text-right tabular-nums">{item.trials ?? UNAVAILABLE_RENDER}</TableCell>
                <TableCell className="text-right tabular-nums">{item.spend ?? UNAVAILABLE_RENDER}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {item.blendedCpa !== null ? item.blendedCpa.toFixed(2) : UNAVAILABLE_RENDER}
                </TableCell>
                <TableCell className="text-xs">
                  {item.publishedVersionNo !== null
                    ? <Badge variant="secondary" className="text-xs font-normal">версия {item.publishedVersionNo}</Badge>
                    : <span className="text-muted-foreground">черновик</span>}
                </TableCell>
                <TableCell className="text-right text-xs text-muted-foreground">
                  {new Date(item.updatedAt).toLocaleDateString()}
                </TableCell>
              </TableRow>
            )) : (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  {loading ? (
                    <span className="inline-flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" /> Загрузка…
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-2">
                      <FileText className="h-4 w-4" /> Отчётов пока нет
                    </span>
                  )}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </AppLayout>
  );
}
