import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Check, Search, X } from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
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
import { FunnelBadge } from "@/components/StatusBadges";
import { getTransactions } from "@/services/sheets";
import { computeUsers, formatCurrency } from "@/services/analytics";
import type { Transaction, UserAggregate } from "@/services/types";

type SortKey = "total_revenue" | "user_ltv" | "renewal_count";

export default function UsersPage() {
  const [txs, setTxs] = useState<Transaction[]>([]);
  const [search, setSearch] = useState("");
  const [funnel, setFunnel] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("total_revenue");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  useEffect(() => {
    getTransactions().then(setTxs);
  }, []);

  const users: UserAggregate[] = useMemo(() => computeUsers(txs), [txs]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = users.filter((u) => {
      if (q && !u.email.toLowerCase().includes(q)) return false;
      if (funnel !== "all" && u.funnel !== funnel) return false;
      return true;
    });
    list.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [users, search, funnel, sortKey, sortDir]);

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
          <Select value={funnel} onValueChange={setFunnel}>
            <SelectTrigger className="h-9 w-[160px]"><SelectValue placeholder="Funnel" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All funnels</SelectItem>
              <SelectItem value="past_life">past life</SelectItem>
              <SelectItem value="soulmate">soulmate</SelectItem>
              <SelectItem value="starseed">starseed</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="mt-4 overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Funnel</TableHead>
                <TableHead>First trial</TableHead>
                <TableHead className="text-right">
                  <button onClick={() => toggleSort("total_revenue")} className="inline-flex items-center gap-1 hover:text-foreground">
                    Total revenue {icon("total_revenue")}
                  </button>
                </TableHead>
                <TableHead className="text-center">Upsell</TableHead>
                <TableHead className="text-center">First sub</TableHead>
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
                  <TableCell className="text-sm">{u.email}</TableCell>
                  <TableCell><FunnelBadge funnel={u.funnel} /></TableCell>
                  <TableCell className="text-xs text-muted-foreground tabular-nums">
                    {u.first_trial_date ? new Date(u.first_trial_date).toLocaleDateString() : "—"}
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
                  <TableCell className="text-right tabular-nums text-sm">{u.renewal_count}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm font-medium">{formatCurrency(u.user_ltv)}</TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-sm text-muted-foreground py-10">
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