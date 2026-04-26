import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Search, X } from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
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
import { FunnelBadge, StatusBadge, TypeBadge } from "@/components/StatusBadges";
import { useTransactions } from "@/services/sheets";
import { formatCurrency } from "@/services/analytics";
import type { TransactionStatus, TransactionType } from "@/services/types";

type SortKey = "event_time" | "amount_usd";
type SortDir = "asc" | "desc";

const TYPES: TransactionType[] = ["trial", "upsell", "first_subscription", "renewal_2", "renewal_3", "renewal", "failed_payment", "refund", "chargeback", "unknown"];
const STATUSES: TransactionStatus[] = ["success", "failed", "refunded", "chargeback"];
const FUNNELS = ["past_life", "soulmate", "starseed", "unknown"] as const;

const PAGE_SIZE = 25;

export default function TransactionsPage() {
  const txs = useTransactions();
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [funnelFilter, setFunnelFilter] = useState<string>("all");
  const [campaignPathFilter, setCampaignPathFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("event_time");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(1);

  const campaignPathOptions = useMemo(() => Array.from(new Set(txs.map((t) => t.campaign_path || "unknown"))).sort(), [txs]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = txs.filter((t) => {
      if (q && !t.email.toLowerCase().includes(q)) return false;
      if (typeFilter !== "all" && t.transaction_type !== typeFilter) return false;
      if (funnelFilter !== "all" && t.funnel !== funnelFilter) return false;
      if (campaignPathFilter !== "all" && (t.campaign_path || "unknown") !== campaignPathFilter) return false;
      if (statusFilter !== "all" && t.status !== statusFilter) return false;
      return true;
    });
    list.sort((a, b) => {
      const av = sortKey === "event_time" ? a.event_time : a.amount_usd;
      const bv = sortKey === "event_time" ? b.event_time : b.amount_usd;
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [txs, search, typeFilter, funnelFilter, campaignPathFilter, statusFilter, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paged = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const sortIcon = (key: SortKey) => {
    if (sortKey !== key) return <ArrowUpDown className="h-3 w-3 opacity-40" />;
    return sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
  };

  const clearFilters = () => {
    setSearch("");
    setTypeFilter("all");
    setFunnelFilter("all");
    setCampaignPathFilter("all");
    setStatusFilter("all");
    setPage(1);
  };

  const hasFilters = search || typeFilter !== "all" || funnelFilter !== "all" || campaignPathFilter !== "all" || statusFilter !== "all";

  return (
    <AppLayout title="Transactions" description={`${filtered.length} of ${txs.length} transactions`}>
      <Card className="p-4 shadow-card">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by email…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="pl-8 h-9"
            />
          </div>
          <Select value={typeFilter} onValueChange={(v) => { setTypeFilter(v); setPage(1); }}>
            <SelectTrigger className="h-9 w-[160px]"><SelectValue placeholder="Type" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {TYPES.map((t) => (
                <SelectItem key={t} value={t}>{t.replace("_", " ")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={funnelFilter} onValueChange={(v) => { setFunnelFilter(v); setPage(1); }}>
            <SelectTrigger className="h-9 w-[140px]"><SelectValue placeholder="Funnel" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All funnels</SelectItem>
              {FUNNELS.map((f) => (
                <SelectItem key={f} value={f}>{f.replace("_", " ")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={campaignPathFilter} onValueChange={(v) => { setCampaignPathFilter(v); setPage(1); }}>
            <SelectTrigger className="h-9 w-[190px]"><SelectValue placeholder="Campaign path" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All campaign paths</SelectItem>
              {campaignPathOptions.map((path) => (
                <SelectItem key={path} value={path}>{path}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
            <SelectTrigger className="h-9 w-[140px]"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters} className="h-9">
              <X className="mr-1 h-4 w-4" /> Clear
            </Button>
          )}
        </div>

        <div className="mt-4 overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-nowrap">
                  <button onClick={() => toggleSort("event_time")} className="inline-flex items-center gap-1 hover:text-foreground">
                    Event time {sortIcon("event_time")}
                  </button>
                </TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Funnel</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Source</TableHead>
                <TableHead className="text-right whitespace-nowrap">
                  <button onClick={() => toggleSort("amount_usd")} className="inline-flex items-center gap-1 hover:text-foreground">
                    Amount {sortIcon("amount_usd")}
                  </button>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paged.map((t) => (
                <TableRow key={t.transaction_id}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">
                    {new Date(t.event_time).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-sm">{t.email}</TableCell>
                  <TableCell><TypeBadge type={t.transaction_type} /></TableCell>
                  <TableCell><StatusBadge status={t.status} /></TableCell>
                  <TableCell><FunnelBadge funnel={t.funnel} /></TableCell>
                  <TableCell className="text-xs text-muted-foreground">{t.product}</TableCell>
                  <TableCell className="text-xs text-muted-foreground capitalize">{t.traffic_source}</TableCell>
                  <TableCell className={`text-right tabular-nums text-sm ${t.amount_usd < 0 ? "text-destructive" : "text-foreground"}`}>
                    {formatCurrency(t.amount_usd)}
                  </TableCell>
                </TableRow>
              ))}
              {paged.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-sm text-muted-foreground py-10">
                    No transactions match your filters.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Page {safePage} of {totalPages}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              Previous
            </Button>
            <Button variant="outline" size="sm" disabled={safePage >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
              Next
            </Button>
          </div>
        </div>
      </Card>
    </AppLayout>
  );
}
