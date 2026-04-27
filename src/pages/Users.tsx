import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Check, Search, X } from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTransactions } from "@/services/sheets";
import { computeUsers, formatCurrency } from "@/services/analytics";
import { formatDateKey, toDateKey } from "@/services/dateKeys";
import type { Transaction, UserAggregate } from "@/services/types";

type SortKey = "first_trial_date" | "total_revenue" | "user_ltv" | "renewal_count" | "has_refund" | "total_refund_usd";
type FirstSubFilter = "all" | "has" | "none";
type RefundFilter = "all" | "has" | "none";
type UserWithCampaignPath = UserAggregate & { campaign_path: string };

function buildCampaignPathByUser(txs: Transaction[]): Map<string, string> {
  const byUser = new Map<string, Transaction[]>();
  for (const tx of txs) {
    const list = byUser.get(tx.user_id) ?? [];
    list.push(tx);
    byUser.set(tx.user_id, list);
  }

  const result = new Map<string, string>();
  byUser.forEach((list, userId) => {
    const sorted = [...list].sort((a, b) => (a.event_time < b.event_time ? -1 : 1));
    const trial = sorted.find((tx) => tx.transaction_type === "trial" && tx.status === "success")
      ?? sorted.find((tx) => tx.transaction_type === "trial");
    const trialCampaignPath = normalizeCampaignPathLabel(trial?.campaign_path);
    if (trialCampaignPath !== "unknown") {
      result.set(userId, trialCampaignPath);
      return;
    }

    const cohortCampaignPath = normalizeCampaignPathLabel(
      sorted.map((tx) => campaignPathFromCohortId(tx.cohort_id)).find((path) => path !== "unknown")
    );
    result.set(userId, cohortCampaignPath);
  });
  return result;
}

function campaignPathFromCohortId(cohortId: string | undefined): string {
  const match = String(cohortId ?? "").match(/^(.*)_\d{4}-\d{2}-\d{2}$/);
  return normalizeCampaignPathLabel(match?.[1]);
}

function normalizeCampaignPathLabel(path: string | undefined): string {
  const value = String(path ?? "").trim();
  return value || "unknown";
}

export default function UsersPage() {
  const txs = useTransactions();
  const [search, setSearch] = useState("");
  const [campaignPathFilter, setCampaignPathFilter] = useState("all");
  const [firstSubFilter, setFirstSubFilter] = useState<FirstSubFilter>("all");
  const [refundFilter, setRefundFilter] = useState<RefundFilter>("all");
  const [firstTrialFrom, setFirstTrialFrom] = useState("");
  const [firstTrialTo, setFirstTrialTo] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("first_trial_date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const users: UserAggregate[] = useMemo(() => computeUsers(txs), [txs]);
  const campaignPathByUser = useMemo(() => buildCampaignPathByUser(txs), [txs]);
  const usersWithCampaignPath: UserWithCampaignPath[] = useMemo(
    () =>
      users.map((user) => ({
        ...user,
        campaign_path: campaignPathByUser.get(user.user_id) ?? "unknown",
      })),
    [users, campaignPathByUser]
  );
  const campaignPathOptions = useMemo(
    () => Array.from(new Set(usersWithCampaignPath.map((user) => user.campaign_path || "unknown"))).sort(),
    [usersWithCampaignPath]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const fromDateKey = toDateKey(firstTrialFrom);
    const toDateKeyValue = toDateKey(firstTrialTo);
    const hasFirstTrialFilter = Boolean(fromDateKey || toDateKeyValue);
    const list = usersWithCampaignPath.filter((u) => {
      if (q && !u.email.toLowerCase().includes(q) && !u.user_id.toLowerCase().includes(q)) return false;
      if (campaignPathFilter !== "all" && u.campaign_path !== campaignPathFilter) return false;
      if (firstSubFilter === "has" && !u.has_first_subscription) return false;
      if (firstSubFilter === "none" && u.has_first_subscription) return false;
      if (refundFilter === "has" && !u.has_refund) return false;
      if (refundFilter === "none" && u.has_refund) return false;
      if (hasFirstTrialFilter) {
        // Date filters intentionally use the first trial date only, not latest transaction activity.
        const firstTrialDateKey = toDateKey(u.first_trial_date);
        if (!firstTrialDateKey) return false;
        if (fromDateKey && firstTrialDateKey < fromDateKey) return false;
        if (toDateKeyValue && firstTrialDateKey > toDateKeyValue) return false;
      }
      return true;
    });
    list.sort((a, b) => {
      const av = sortKey === "first_trial_date" ? toDateKey(a.first_trial_date) : a[sortKey] ?? "";
      const bv = sortKey === "first_trial_date" ? toDateKey(b.first_trial_date) : b[sortKey] ?? "";
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [usersWithCampaignPath, search, campaignPathFilter, firstSubFilter, refundFilter, firstTrialFrom, firstTrialTo, sortKey, sortDir]);

  const hasFirstTrialFilter = Boolean(firstTrialFrom || firstTrialTo);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("desc"); }
  };

  const icon = (key: SortKey) =>
    sortKey !== key ? <ArrowUpDown className="h-3 w-3 opacity-40" /> :
    sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;

  return (
    <AppLayout title="Users" description={`${filtered.length} users`}>
      <Card className="p-4 shadow-card">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by email…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-9"
            />
          </div>
          <Select value={campaignPathFilter} onValueChange={setCampaignPathFilter}>
            <SelectTrigger className="h-9 w-[220px]"><SelectValue placeholder="Campaign path" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All campaign paths</SelectItem>
              {campaignPathOptions.map((path) => (
                <SelectItem key={path} value={path}>{path}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            First sub
            <Select value={firstSubFilter} onValueChange={(value: FirstSubFilter) => setFirstSubFilter(value)}>
              <SelectTrigger className="h-9 w-[150px]"><SelectValue placeholder="First sub" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="has">Has First Sub</SelectItem>
                <SelectItem value="none">No First Sub</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Refund
            <Select value={refundFilter} onValueChange={(value: RefundFilter) => setRefundFilter(value)}>
              <SelectTrigger className="h-9 w-[140px]"><SelectValue placeholder="Refund" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="has">Has refund</SelectItem>
                <SelectItem value="none">No refund</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            First trial from
            <Input
              type="date"
              value={firstTrialFrom}
              onChange={(e) => setFirstTrialFrom(e.target.value)}
              className="h-9 w-[150px]"
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            First trial to
            <Input
              type="date"
              value={firstTrialTo}
              onChange={(e) => setFirstTrialTo(e.target.value)}
              className="h-9 w-[150px]"
            />
          </label>
          {hasFirstTrialFilter && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setFirstTrialFrom("");
                setFirstTrialTo("");
              }}
            >
              Clear date filter
            </Button>
          )}
        </div>

        <div className="mt-4 overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Campaign path</TableHead>
                <TableHead>First trial</TableHead>
                <TableHead className="text-right">
                  <button onClick={() => toggleSort("total_revenue")} className="inline-flex items-center gap-1 hover:text-foreground">
                    Total revenue {icon("total_revenue")}
                  </button>
                </TableHead>
                <TableHead className="text-center">Upsell</TableHead>
                <TableHead className="text-center">First sub</TableHead>
                <TableHead className="text-center">
                  <button onClick={() => toggleSort("has_refund")} className="inline-flex items-center gap-1 hover:text-foreground">
                    Refund {icon("has_refund")}
                  </button>
                </TableHead>
                <TableHead className="text-right">
                  <button onClick={() => toggleSort("total_refund_usd")} className="inline-flex items-center gap-1 hover:text-foreground">
                    Amount Refunded {icon("total_refund_usd")}
                  </button>
                </TableHead>
                <TableHead className="text-right">
                  <button onClick={() => toggleSort("renewal_count")} className="inline-flex items-center gap-1 hover:text-foreground">
                    Renewals {icon("renewal_count")}
                  </button>
                </TableHead>
                <TableHead className="text-right">
                  <button onClick={() => toggleSort("user_ltv")} className="inline-flex items-center gap-1 hover:text-foreground">
                    LTV {icon("user_ltv")}
                  </button>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((u) => (
                <TableRow key={u.user_id}>
                  <TableCell className="text-sm">{u.email || "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{u.campaign_path || "unknown"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground tabular-nums">
                    {u.first_trial_date ? formatDateKey(u.first_trial_date) : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(u.total_revenue)}</TableCell>
                  <TableCell className="text-center">
                    {u.has_upsell
                      ? <Check className="inline h-4 w-4 text-success" />
                      : <X className="inline h-4 w-4 text-muted-foreground/50" />}
                  </TableCell>
                  <TableCell className="text-center">
                    {u.has_first_subscription
                      ? <Check className="inline h-4 w-4 text-success" />
                      : <X className="inline h-4 w-4 text-muted-foreground/50" />}
                  </TableCell>
                  <TableCell className="text-center">
                    {u.has_refund
                      ? <Check className="inline h-4 w-4 text-success" />
                      : <X className="inline h-4 w-4 text-muted-foreground/50" />}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(u.total_refund_usd)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{u.renewal_count}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm font-medium">{formatCurrency(u.user_ltv)}</TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={10} className="text-center text-sm text-muted-foreground py-10">
                    No users match your filters.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
    </AppLayout>
  );
}
