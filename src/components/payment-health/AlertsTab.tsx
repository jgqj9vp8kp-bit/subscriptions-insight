// Alerts tab (plan Q, phase P2.5): the payment risk alerts the daily checks
// raised (alerts_list), their evidence and explanation, and — for holders of
// payment_health.manage_alerts — the status buttons and "Run checks now".
//
// What the tab guarantees on screen:
//   * a low-confidence alert (small sample, incomplete window) reads "Info" with
//     a "low confidence" badge, never warning / critical;
//   * the explanation is the engine's four parts, each labelled: fact, likely
//     explanation, the hypothesis marked "unverified", recommended actions (a
//     text the plan Q ban flags is withheld — the engine refuses those already);
//   * issuer fraud-suspicion alerts say they are decline codes, not fraud;
//   * scope and evidence show registry labels and numbers only: no raw MID,
//     descriptor, card fragment, e-mail or member id (an assignee or a history
//     entry reads "you" / "a teammate" / "the alert engine");
//   * the buttons appear only when the access context grants the manage key AND
//     the server's meta.can_manage agrees; the server re-checks every change.
// PSP-scoped alerts arrive only for callers with payment_health.psp_global.view
// (the server filters them); the tab just says how many were left out.

import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, ExternalLink, Loader2, Play } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useAlertStatusMutation, usePaymentAlertsQuery, useRunAlertsMutation } from "@/hooks/usePaymentHealth";
import { describePaymentHealthError, type AlertsListResponse, type PaymentRiskAlert } from "@/services/paymentHealthDataSource";
import {
  ALERT_NOTE_MAX_LENGTH,
  type AlertRuleView,
  type AlertRunSummary,
  type AlertSeverity,
  type AlertStatus,
} from "../../../supabase/functions/_shared/clickhouse/paymentRiskAlertsContract";
import { fmtDateTime, fmtNum } from "./format";
import { EmptyNote, QueryFrame, SectionCard } from "./shared";
import {
  ALERT_SEVERITY_FILTERS,
  ALERT_STATUS_FILTERS,
  ALL,
  TAB_LABELS,
  alertsFilters,
  parseAlertReproduce,
  reproduceState,
  type AlertSeverityFilter,
  type AlertStatusFilter,
  type PaymentHealthUiState,
} from "./pageState";
import {
  RULE_CAPTIONS,
  SEVERITY_LABELS,
  STATUS_LABELS,
  accountCounts,
  actorText,
  alertActionErrorText,
  alertFlags,
  compliantActions,
  compliantText,
  countEvidenceRows,
  displaySeverity,
  fmtAlertChange,
  fmtAlertValue,
  historyText,
  nextManualRunAt,
  rateEvidence,
  rateParts,
  ruleTitle,
  runSummaryText,
  scopeLabels,
  statusActions,
} from "./alertsModel";

export interface AlertsTabProps {
  userScopeHash: string;
  /** False while no request may be sent (the hook also waits for the access partition). */
  enabled: boolean;
  statusFilter: AlertStatusFilter;
  severityFilter: AlertSeverityFilter;
  onFiltersChange: (patch: Partial<Pick<PaymentHealthUiState, "alertStatus" | "alertSeverity">>) => void;
  /** payment_health.manage_alerts in the access context (meta.can_manage must agree). */
  canManage: boolean;
  /** The signed-in member's auth user id: lets history and assignee say "you". */
  currentUserId: string | null;
  /** Applies the page-state patch of an alert's evidence.reproduce (tab, window, filters). */
  onReproduce?: (patch: Partial<PaymentHealthUiState>) => void;
}

const SEVERITY_CLASS: Record<AlertSeverity, string> = {
  critical: "bg-destructive text-destructive-foreground",
  warning: "border border-warning/40 bg-warning/15 text-warning",
  info: "bg-muted text-muted-foreground",
};

const STATUS_CLASS: Record<AlertStatus, string> = {
  new: "border-primary/50 text-primary",
  investigating: "border-warning/50 text-warning",
  resolved: "text-success",
  dismissed: "text-muted-foreground",
};

function SeverityBadge({ alert }: { alert: PaymentRiskAlert }) {
  const severity = displaySeverity(alert);
  return (
    <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium", SEVERITY_CLASS[severity])} data-testid="alert-severity" data-severity={severity}>
      {SEVERITY_LABELS[severity]}
    </span>
  );
}

function StatusBadge({ alert }: { alert: PaymentRiskAlert }) {
  return (
    <Badge variant="outline" className={cn("px-1.5 py-0 text-[10px] font-medium", STATUS_CLASS[alert.status])} data-testid="alert-status">
      {STATUS_LABELS[alert.status] ?? alert.status}
      {alert.status === "resolved" && alert.auto_resolved ? " (auto)" : ""}
    </Badge>
  );
}

function AlertFlags({ flags }: { flags: string[] }) {
  if (!flags.length) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {flags.map((flag) => (
        <Badge
          key={flag}
          variant={flag === "significant" ? "default" : "outline"}
          className={cn("px-1.5 py-0 text-[10px] font-medium", flag !== "significant" && "text-muted-foreground", (flag === "low confidence" || flag === "incomplete window") && "border-dashed")}
          data-testid={flag === "low confidence" ? "low-confidence" : undefined}
        >
          {flag}
        </Badge>
      ))}
    </span>
  );
}

function Part({ label, badge, children, testId }: { label: string; badge?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId}>
      {/* A div, not a p: the badge (Badge renders a div) sits inside it. */}
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
        {badge}
      </div>
      <div className="mt-0.5 text-sm text-foreground">{children}</div>
    </div>
  );
}

function Explanation({ alert }: { alert: PaymentRiskAlert }) {
  const explanation = alert.explanation ?? { fact: "", likely_explanation: "", hypothesis: "", action: [] };
  const likely = compliantText(explanation.likely_explanation);
  const hypothesis = compliantText(explanation.hypothesis);
  const actions = compliantActions(explanation.action);
  return (
    <div className="space-y-3" data-testid="alert-explanation">
      <Part label="Fact" testId="explanation-fact">{explanation.fact || "—"}</Part>
      <Part label="Likely explanation" testId="explanation-likely">
        {likely ?? <span className="text-muted-foreground">Not shown: the text did not pass the compliance check.</span>}
      </Part>
      <Part
        label="Hypothesis"
        testId="explanation-hypothesis"
        badge={<Badge variant="outline" className="border-dashed border-warning/60 px-1.5 py-0 text-[10px] font-medium normal-case tracking-normal text-warning" data-testid="hypothesis-unverified">unverified</Badge>}
      >
        {hypothesis ?? <span className="text-muted-foreground">Not shown: the text did not pass the compliance check.</span>}
      </Part>
      <Part label="Recommended actions" testId="explanation-actions">
        {actions.shown.length > 0 && (
          <ul className="list-disc space-y-1 pl-4">
            {actions.shown.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ul>
        )}
        {actions.withheld > 0 && (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="actions-withheld">
            {fmtNum(actions.withheld)} recommended action(s) not shown: they did not pass the compliance check.
          </p>
        )}
        {actions.shown.length === 0 && actions.withheld === 0 && <span className="text-muted-foreground">—</span>}
      </Part>
    </div>
  );
}

function RateEvidenceTable({ alert }: { alert: PaymentRiskAlert }) {
  const evidence = rateEvidence(alert.evidence);
  if (!evidence) return null;
  const parts = rateParts(alert.rule_key, alert.scope);
  const sides = [
    { label: "Current", side: evidence.current },
    { label: "Previous", side: evidence.baseline },
  ];
  return (
    <div className="space-y-2" data-testid="alert-rate-evidence">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Window</TableHead>
              <TableHead>Days</TableHead>
              <TableHead className="text-right">{parts.numerator}</TableHead>
              <TableHead className="text-right">{parts.denominator}</TableHead>
              <TableHead className="text-right">Rate</TableHead>
              <TableHead className="text-right">95% interval</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sides.map(({ label, side }) => (
              <TableRow key={label}>
                <TableCell className="text-xs font-medium">{label}</TableCell>
                <TableCell className="text-xs tabular-nums">{side.from ?? "—"} – {side.to ?? "—"}</TableCell>
                <TableCell className="text-right text-xs tabular-nums">{fmtNum(side.numerator)}</TableCell>
                <TableCell className="text-right text-xs tabular-nums">{fmtNum(side.denominator)}</TableCell>
                <TableCell className="text-right text-xs font-medium tabular-nums">{fmtAlertValue("rate", side.rate)}</TableCell>
                <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                  {side.interval ? `${fmtAlertValue("rate", side.interval.low)} – ${fmtAlertValue("rate", side.interval.high)}` : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
        <EvidenceFact label="Change" value={fmtAlertChange("rate", evidence.deltaPoints)} />
        <EvidenceFact label="Significance" value={evidence.significanceText} />
        {evidence.thresholds && <EvidenceFact label="Thresholds" value={`warning ≥ ${evidence.thresholds.warning} pp · critical ≥ ${evidence.thresholds.critical} pp`} />}
        {evidence.minSample != null && (
          <EvidenceFact label="Minimum sample" value={`${fmtNum(evidence.minSample)} per window${evidence.minSampleInfo != null ? ` (looked at from ${fmtNum(evidence.minSampleInfo)}, as info only)` : ""}`} />
        )}
        {evidence.dataThrough && <EvidenceFact label="Data through" value={evidence.dataThrough} />}
        {evidence.maturityDays != null && <EvidenceFact label="Maturity" value={`windows are read ${fmtNum(evidence.maturityDays)} days after they end (by original payment date)`} />}
        {evidence.maturityBasis === "received_at" && <EvidenceFact label="Basis" value="complaints by received date over the window's settled payments" />}
        {evidence.maturityBasis === "received_at" && (
          <EvidenceFact label="Support data through" value={evidence.supportThrough ?? "no support data in the warehouse"} />
        )}
        {evidence.parts && (
          <EvidenceFact
            label="Parts (current / previous)"
            value={`integration ${fmtNum(evidence.parts.current.integration)} / ${fmtNum(evidence.parts.baseline.integration)} · unrouted, cause not verified ${fmtNum(evidence.parts.current.unverified)} / ${fmtNum(evidence.parts.baseline.unverified)}`}
          />
        )}
      </dl>
    </div>
  );
}

function EvidenceFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap gap-x-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

function Evidence({ alert, pspVisible }: { alert: PaymentRiskAlert; pspVisible: boolean }) {
  const rate = alert.unit === "rate" ? <RateEvidenceTable alert={alert} /> : null;
  const rows = alert.unit === "rate" ? [] : countEvidenceRows(alert);
  // Account labels are PSP detail: the server strips them without the key, and so does the tab.
  const accounts = pspVisible ? accountCounts(alert.evidence) : [];
  return (
    <div className="space-y-2" data-testid="alert-evidence">
      {rate}
      {rows.length > 0 && (
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2" data-testid="alert-count-evidence">
          {rows.map((row) => (
            <EvidenceFact key={row.label} label={row.label} value={row.value} />
          ))}
        </dl>
      )}
      {accounts.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="alert-accounts">
          By merchant account:{" "}
          {accounts.map((entry, index) => (
            <span key={`${entry.label}|${index}`} className="text-foreground">
              {index > 0 && ", "}
              {entry.processor ? `${entry.processor} · ` : ""}
              {entry.label} ({fmtNum(entry.count)})
            </span>
          ))}
        </p>
      )}
      {alert.affected_funnels.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="alert-funnels">
          Funnels that moved it most: <span className="text-foreground">{alert.affected_funnels.join(", ")}</span>
        </p>
      )}
    </div>
  );
}

function ReproduceLink({ alert, pspVisible, onReproduce }: { alert: PaymentRiskAlert; pspVisible: boolean; onReproduce?: AlertsTabProps["onReproduce"] }) {
  const reproduce = parseAlertReproduce((alert.evidence as Record<string, unknown> | null)?.reproduce);
  const patch = reproduce ? reproduceState(reproduce, pspVisible) : null;
  if (!reproduce || !patch?.tab || !onReproduce) return null;
  const tabLabel = TAB_LABELS[patch.tab];
  const window = reproduce.dateFrom && reproduce.dateTo ? `${reproduce.dateFrom} – ${reproduce.dateTo}` : null;
  const initiation = reproduce.filters.initiation?.[0];
  const dimensionCaption = reproduce.dimension === "merchant_account" ? "by merchant account" : reproduce.dimension === "processor" ? "by processor" : null;
  const caption = [window, initiation ? initiation.toUpperCase() : null, dimensionCaption].filter(Boolean).join(" · ");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => onReproduce(patch)} data-testid="alert-reproduce">
        <ExternalLink className="h-3.5 w-3.5" /> Open in {tabLabel}
      </Button>
      {caption && <span className="text-[10px] text-muted-foreground">{caption} — the page answers with the same numbers</span>}
    </div>
  );
}

function History({ alert, currentUserId }: { alert: PaymentRiskAlert; currentUserId: string | null }) {
  const entries = Array.isArray(alert.status_history) ? [...alert.status_history].reverse() : [];
  if (!entries.length) return null;
  return (
    <div data-testid="alert-history">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">History</p>
      <ul className="mt-1 space-y-1 text-xs">
        {entries.map((entry, index) => (
          <li key={`${entry.at}|${index}`}>
            <span className="tabular-nums text-muted-foreground">{fmtDateTime(entry.at)}</span> · {historyText(entry, currentUserId)}
            {entry.note && <span className="block pl-3 text-muted-foreground">“{entry.note}”</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface StatusControls {
  pendingAlertId: string | null;
  onChange: (alert: PaymentRiskAlert, to: AlertStatus, note: string) => void;
}

function StatusActions({ alert, controls }: { alert: PaymentRiskAlert; controls: StatusControls }) {
  const [note, setNote] = useState("");
  // A status that changed (here or by a teammate) clears the draft note: it belonged to the previous step.
  useEffect(() => setNote(""), [alert.status]);
  const actions = statusActions(alert.status);
  const pending = controls.pendingAlertId === alert.id;
  const noteId = `alert-note-${alert.id}`;
  if (!actions.length) return null;
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3" data-testid="alert-actions">
      <Label htmlFor={noteId} className="text-xs text-muted-foreground">Note (optional, saved in the history)</Label>
      <Textarea id={noteId} value={note} onChange={(event) => setNote(event.target.value)} maxLength={ALERT_NOTE_MAX_LENGTH} rows={2} className="min-h-[56px] text-sm" />
      <div className="flex flex-wrap items-center gap-2">
        {actions.map((action) => (
          <Button
            key={action.to}
            type="button"
            size="sm"
            variant={action.to === "investigating" ? "default" : "outline"}
            disabled={controls.pendingAlertId != null}
            onClick={() => controls.onChange(alert, action.to, note)}
          >
            {action.label}
          </Button>
        ))}
        {pending && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…
          </span>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground">{note.length} / {ALERT_NOTE_MAX_LENGTH}</span>
      </div>
    </div>
  );
}

function AlertDetails({ alert, canManage, pspVisible, currentUserId, onReproduce, controls }: {
  alert: PaymentRiskAlert;
  canManage: boolean;
  pspVisible: boolean;
  currentUserId: string | null;
  onReproduce?: AlertsTabProps["onReproduce"];
  controls: StatusControls;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 py-2 xl:grid-cols-2" data-testid={`alert-details-${alert.id}`}>
      <div className="space-y-3">
        {alert.data_confidence === "low" && (
          <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground" role="note">
            Low confidence: the sample was small or the window was still incomplete, so this is information only — not a warning.
          </p>
        )}
        <Explanation alert={alert} />
      </div>
      <div className="space-y-3">
        <Evidence alert={alert} pspVisible={pspVisible} />
        <ReproduceLink alert={alert} pspVisible={pspVisible} onReproduce={onReproduce} />
        <History alert={alert} currentUserId={currentUserId} />
        {canManage && <StatusActions alert={alert} controls={controls} />}
      </div>
    </div>
  );
}

const COLUMNS = 8;

function AlertRows({ alert, expanded, onToggle, ...details }: {
  alert: PaymentRiskAlert;
  expanded: boolean;
  onToggle: () => void;
  canManage: boolean;
  pspVisible: boolean;
  currentUserId: string | null;
  onReproduce?: AlertsTabProps["onReproduce"];
  controls: StatusControls;
}) {
  const title = ruleTitle(alert.rule_key);
  const scope = scopeLabels(alert.scope);
  const caption = RULE_CAPTIONS[alert.rule_key];
  const flags = alertFlags(alert);
  const severity = displaySeverity(alert);
  const detailsId = `alert-details-row-${alert.id}`;
  return (
    <Fragment>
      <TableRow data-testid={`alert-row-${alert.id}`} data-state={expanded ? "open" : "closed"} className={cn(alert.status === "resolved" || alert.status === "dismissed" ? "opacity-75" : undefined)}>
        <TableCell className="w-8 p-2 align-top">
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-expanded={expanded} aria-controls={detailsId} aria-label={`Details: ${title}`} onClick={onToggle}>
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </Button>
        </TableCell>
        <TableCell className="align-top">
          <SeverityBadge alert={alert} />
        </TableCell>
        <TableCell className="min-w-[220px] align-top">
          <p className="text-sm font-medium text-foreground">{title}</p>
          {caption && <p className="text-[10px] text-muted-foreground">{caption}</p>}
          <div className="mt-0.5 text-xs text-foreground">
            {scope.primary}
            {scope.unlabelled && <Badge variant="outline" className="ml-1 px-1 py-0 text-[10px] text-muted-foreground">unlabelled</Badge>}
            {scope.details.length > 0 && <span className="text-muted-foreground"> · {scope.details.join(" · ")}</span>}
          </div>
          {alert.affected_funnels.length > 0 && <p className="text-[10px] text-muted-foreground">Funnels: {alert.affected_funnels.join(", ")}</p>}
        </TableCell>
        <TableCell className="text-right align-top tabular-nums">
          <span className="block text-sm font-medium">{fmtAlertValue(alert.unit, alert.current_value)}</span>
          {alert.baseline_value != null && (
            <span className="block text-[10px] text-muted-foreground">
              vs {fmtAlertValue(alert.unit, alert.baseline_value)} ·{" "}
              <span className={cn(severity === "info" ? "text-muted-foreground" : "text-destructive")}>{fmtAlertChange(alert.unit, alert.change_value)}</span>
            </span>
          )}
          <span className="block font-mono text-[10px] text-muted-foreground">{alert.metric}</span>
        </TableCell>
        <TableCell className="align-top">
          <span className="block text-xs tabular-nums">n = {fmtNum(alert.sample_size)}</span>
          <AlertFlags flags={flags} />
        </TableCell>
        <TableCell className="whitespace-nowrap align-top text-xs tabular-nums">{alert.window_start ? `${alert.window_start} – ${alert.window_end}` : `through ${alert.window_end}`}</TableCell>
        <TableCell className="whitespace-nowrap align-top text-[11px] tabular-nums text-muted-foreground">
          <span className="block">first {fmtDateTime(alert.first_seen_at)}</span>
          <span className="block">last {fmtDateTime(alert.last_seen_at)}</span>
        </TableCell>
        <TableCell className="align-top">
          <StatusBadge alert={alert} />
          {alert.assignee && <span className="block text-[10px] text-muted-foreground">assigned to {actorText(alert.assignee, details.currentUserId)}</span>}
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow id={detailsId} className="bg-muted/20 hover:bg-muted/20">
          <TableCell colSpan={COLUMNS} className="px-4">
            <AlertDetails alert={alert} {...details} />
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  );
}

function RulesCard({ rules, lastRun }: { rules: AlertRuleView[]; lastRun: AlertRunSummary | null }) {
  const [open, setOpen] = useState(false);
  const outcomes = new Map((lastRun?.rules ?? []).map((outcome) => [outcome.rule_key, outcome]));
  const thresholdText = (rule: AlertRuleView, value: number) => (rule.unit === "rate" ? `${value} pp` : fmtAlertValue(rule.unit, value));
  return (
    <SectionCard
      title="Rules and thresholds"
      description="What each check looks at; the owner sets the thresholds. A rule raises a warning or a critical alert only on a significant change with at least the minimum sample in both windows."
      testId="alert-rules"
      actions={
        <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? "Hide rules" : `Show rules (${fmtNum(rules.length)})`}
        </Button>
      }
    >
      {open && (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Rule</TableHead>
                <TableHead>Window</TableHead>
                <TableHead>Warning / critical</TableHead>
                <TableHead className="text-right">Min sample</TableHead>
                <TableHead>Last check</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((rule) => {
                const outcome = outcomes.get(rule.rule_key);
                return (
                  <TableRow key={rule.rule_key}>
                    <TableCell className="max-w-[420px]">
                      <div className="text-xs font-medium">
                        {rule.title}
                        {!rule.enabled && <Badge variant="outline" className="ml-1 px-1 py-0 text-[10px] text-muted-foreground">disabled</Badge>}
                      </div>
                      <p className="text-[10px] text-muted-foreground">{rule.description}</p>
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">{fmtNum(rule.window_days)} d</TableCell>
                    <TableCell className="text-xs tabular-nums">{thresholdText(rule, rule.severity_warning)} / {thresholdText(rule, rule.severity_critical)}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{fmtNum(rule.min_sample)}</TableCell>
                    <TableCell className="text-xs">
                      {outcome ? (
                        <>
                          {outcome.status}
                          {outcome.reason && <span className="block text-[10px] text-muted-foreground">{outcome.reason}</span>}
                          {outcome.status === "evaluated" && (
                            <span className="block text-[10px] text-muted-foreground">
                              {fmtNum(outcome.candidates)} found · {fmtNum(outcome.cleared)} clear · {fmtNum(outcome.inconclusive)} too small to decide
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </SectionCard>
  );
}

/** Re-renders once at `deadline` (ms since epoch), so a cool-down that ends re-enables its button. */
function useRerenderAt(deadline: number | null): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (deadline == null) return;
    const wait = deadline - Date.now();
    if (wait <= 0) return;
    const id = setTimeout(() => setTick((tick) => tick + 1), Math.min(wait + 250, 2_000_000_000));
    return () => clearTimeout(id);
  }, [deadline]);
}

type Notice = { kind: "ok" | "error"; text: string };

interface AlertsMutations {
  statusMutation: ReturnType<typeof useAlertStatusMutation>;
  runMutation: ReturnType<typeof useRunAlertsMutation>;
  notice: Notice | null;
  setNotice: (notice: Notice | null) => void;
}

function AlertsBody({ data, props, mutations }: { data: AlertsListResponse; props: AlertsTabProps; mutations: AlertsMutations }) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const { statusMutation, runMutation, notice, setNotice } = mutations;
  const canManage = props.canManage && data.meta.can_manage === true;
  const pspVisible = data.meta.psp_global_visible === true;
  // The server already leaves PSP-scoped alerts out for a caller without the PSP key; never render one anyway.
  const alerts = data.alerts.filter((alert) => pspVisible || !alert.psp_scoped);
  const lastRun = data.last_run;
  const nextRunAt = nextManualRunAt(lastRun, data.meta.run_min_interval_seconds);
  useRerenderAt(nextRunAt);
  const coolingDown = nextRunAt != null && nextRunAt > Date.now();
  const intervalMinutes = Math.round(data.meta.run_min_interval_seconds / 60);

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const controls: StatusControls = {
    pendingAlertId: statusMutation.isPending ? statusMutation.variables?.alertId ?? null : null,
    onChange: (alert, to, note) => {
      setNotice(null);
      statusMutation.mutate(
        { alertId: alert.id, status: to, note },
        {
          onSuccess: (response) => {
            const scope = scopeLabels(response.alert.scope);
            setNotice({ kind: "ok", text: `${ruleTitle(response.alert.rule_key)} (${scope.primary}) is now ${STATUS_LABELS[response.alert.status] ?? response.alert.status}.` });
          },
          onError: (error) => setNotice({ kind: "error", text: alertActionErrorText(describePaymentHealthError(error)) }),
        },
      );
    },
  };

  const runNow = () => {
    setNotice(null);
    runMutation.mutate(undefined, {
      onSuccess: (response) => setNotice({ kind: response.run?.status === "failed" ? "error" : "ok", text: response.run ? `Checks finished. ${runSummaryText(response.run)}` : "Another check had just started; the list shows its result." }),
      onError: (error) => setNotice({ kind: "error", text: alertActionErrorText(describePaymentHealthError(error)) }),
    });
  };

  const statusFilter = props.statusFilter;
  const filtered = statusFilter !== "open" || props.severityFilter !== ALL;
  const lastRunPhrase = lastRun
    ? `last run at ${fmtDateTime(lastRun.finished_at ?? lastRun.started_at)}${lastRun.status === "failed" ? " (failed)" : lastRun.status === "running" ? " (still running)" : ""}`
    : "no check has run yet";
  const emptyText = filtered ? `No alerts match these filters — ${lastRunPhrase}.` : `No open alerts — ${lastRunPhrase}.`;

  return (
    <>
      <SectionCard
        title="Payment risk alerts"
        description="Raised by the daily checks over fixed windows of whole days that end the day before “data through”, which is partial (7 days against the 7 before; the last 30 days for re-attempts; refunds on the newest mature window). The page window and the filters above do not apply here. Small samples and incomplete windows give information only, never a warning."
        testId="alerts-header"
        actions={
          canManage ? (
            <div className="flex flex-col items-end gap-1">
              <Button type="button" size="sm" onClick={runNow} disabled={runMutation.isPending || coolingDown} data-testid="alerts-run-now">
                {runMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                {runMutation.isPending ? "Running checks…" : "Run checks now"}
              </Button>
              {coolingDown && nextRunAt != null && (
                <span className="text-[10px] text-muted-foreground" data-testid="alerts-run-cooldown">
                  One check per {intervalMinutes} minutes: next after {fmtDateTime(new Date(nextRunAt).toISOString())}
                </span>
              )}
              {runMutation.isPending && <span className="text-[10px] text-muted-foreground">This can take up to two minutes.</span>}
            </div>
          ) : undefined
        }
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Status</Label>
            <Select value={props.statusFilter} onValueChange={(value) => props.onFiltersChange({ alertStatus: value as AlertStatusFilter })}>
              <SelectTrigger className="h-9 w-[220px]" aria-label="Alert status"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ALERT_STATUS_FILTERS.map((entry) => (
                  <SelectItem key={entry.key} value={entry.key}>{entry.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Severity</Label>
            <Select value={props.severityFilter} onValueChange={(value) => props.onFiltersChange({ alertSeverity: value as AlertSeverityFilter })}>
              <SelectTrigger className="h-9 w-[160px]" aria-label="Alert severity"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ALERT_SEVERITY_FILTERS.map((entry) => (
                  <SelectItem key={entry.key} value={entry.key}>{entry.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="ml-auto text-right text-xs text-muted-foreground" data-testid="alerts-last-run">
            {lastRun ? runSummaryText(lastRun) : "No check has run yet: the scheduled check runs once a day."}
          </div>
        </div>
        <div className="mt-3 space-y-1 text-xs">
          {notice && (
            <p className={cn("flex items-start gap-1.5", notice.kind === "ok" ? "text-success" : "text-destructive")} role={notice.kind === "ok" ? "status" : "alert"} data-testid="alerts-notice">
              {notice.kind === "ok" ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
              {notice.text}
            </p>
          )}
          {data.hidden_psp_scoped > 0 && (
            <p className="text-muted-foreground" data-testid="alerts-psp-not-shown">
              {fmtNum(data.hidden_psp_scoped)} alert(s) about PSP accounts are not shown: they need the PSP accounts permission (payment_health.psp_global.view).
            </p>
          )}
          {data.meta.limited && (
            <p className="text-warning" data-testid="alerts-limited">Showing {fmtNum(data.meta.limit)} alerts; more match these filters. Narrow them to see the rest.</p>
          )}
        </div>
      </SectionCard>

      <SectionCard title={filtered ? "Alerts" : "Open alerts"} description="Open first, then by severity and the newest check. Expand a row for the evidence, the explanation and the history." testId="alerts-list">
        {alerts.length === 0 ? (
          <EmptyNote>
            <span data-testid="alerts-empty">{emptyText}</span>
          </EmptyNote>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"><span className="sr-only">Details</span></TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Alert</TableHead>
                  <TableHead className="text-right">Current vs previous</TableHead>
                  <TableHead>Sample</TableHead>
                  <TableHead>Window</TableHead>
                  <TableHead>Seen</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {alerts.map((alert) => (
                  <AlertRows
                    key={alert.id}
                    alert={alert}
                    expanded={expanded.has(alert.id)}
                    onToggle={() => toggle(alert.id)}
                    canManage={canManage}
                    pspVisible={pspVisible}
                    currentUserId={props.currentUserId}
                    onReproduce={props.onReproduce}
                    controls={controls}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      <RulesCard rules={data.rules} lastRun={lastRun} />
    </>
  );
}

export function AlertsTab(props: AlertsTabProps) {
  const filters = useMemo(() => alertsFilters({ alertStatus: props.statusFilter, alertSeverity: props.severityFilter }), [props.statusFilter, props.severityFilter]);
  const result = usePaymentAlertsQuery({ filters, userScopeHash: props.userScopeHash, enabled: props.enabled });
  // The mutations and the last change's outcome live here, above QueryFrame: the
  // alert a notice names may leave the filtered list once the refetch lands, and
  // a list that fails to load replaces the whole body with its error card — a run
  // that takes two minutes must keep its pending state and its answer across
  // that, not re-enable "Run checks now" halfway or drop its result.
  const statusMutation = useAlertStatusMutation();
  const runMutation = useRunAlertsMutation();
  const [notice, setNotice] = useState<Notice | null>(null);
  const mutations: AlertsMutations = { statusMutation, runMutation, notice, setNotice };
  // The SPA ships from main on its own schedule; a function deployed before
  // P2.5 answers alerts_list with 400 unknown_action. Say that plainly instead
  // of a generic error card with a Retry that cannot help.
  if (result.data == null && result.error?.errorCode === "unknown_action") {
    return (
      <SectionCard title="Payment risk alerts" testId="alerts-not-deployed">
        <EmptyNote>The alert checks are not deployed on the server yet; this tab fills once they are.</EmptyNote>
      </SectionCard>
    );
  }
  return (
    <QueryFrame result={result} label="alerts">
      {(data) => <AlertsBody data={data} props={props} mutations={mutations} />}
    </QueryFrame>
  );
}
