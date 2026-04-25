import { useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ArrowUpRight,
  CreditCard,
  DollarSign,
  Repeat,
  Sparkles,
  TrendingUp,
  Users as UsersIcon,
  Wallet,
} from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { Card } from "@/components/ui/card";
import { KpiCard } from "@/components/KpiCard";
import { getTransactions } from "@/services/sheets";
import {
  computeKpis,
  formatCurrency,
  formatPct,
  revenueByDay,
  revenueByFunnel,
  revenueByType,
  trialFunnel,
} from "@/services/analytics";
import type { Transaction } from "@/services/types";

const TYPE_LABEL: Record<string, string> = {
  trial: "Trial",
  upsell: "Upsell",
  first_subscription: "First Sub",
  renewal: "Renewal",
  refund: "Refund",
  chargeback: "Chargeback",
};

export default function Dashboard() {
  const [txs, setTxs] = useState<Transaction[]>([]);

  useEffect(() => {
    getTransactions().then(setTxs);
  }, []);

  const kpis = computeKpis(txs);
  const daily = revenueByDay(txs);
  const byType = revenueByType(txs).map((d) => ({ ...d, label: TYPE_LABEL[d.type] ?? d.type }));
  const byFunnel = revenueByFunnel(txs);
  const funnel = trialFunnel(txs);

  return (
    <AppLayout title="Dashboard" description="Subscription performance overview">
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Total Revenue" value={formatCurrency(kpis.totalRevenue)} icon={<DollarSign className="h-4 w-4" />} accent="primary" />
        <KpiCard label="Trial Payments" value={formatCurrency(kpis.trialPayments)} icon={<Sparkles className="h-4 w-4" />} accent="accent" />
        <KpiCard label="Upsell Revenue" value={formatCurrency(kpis.upsellRevenue)} icon={<ArrowUpRight className="h-4 w-4" />} accent="accent" />
        <KpiCard label="First Subscription" value={formatCurrency(kpis.firstSubscriptionRevenue)} icon={<CreditCard className="h-4 w-4" />} accent="success" />
        <KpiCard label="Renewal Revenue" value={formatCurrency(kpis.renewalRevenue)} icon={<Repeat className="h-4 w-4" />} accent="primary" />
        <KpiCard label="Trial → Upsell CR" value={formatPct(kpis.trialToUpsellCR)} icon={<TrendingUp className="h-4 w-4" />} accent="accent" />
        <KpiCard label="Trial → First Sub CR" value={formatPct(kpis.trialToFirstSubscriptionCR)} icon={<UsersIcon className="h-4 w-4" />} accent="success" />
        <KpiCard label="Avg LTV / User" value={formatCurrency(kpis.averageLtv)} icon={<Wallet className="h-4 w-4" />} accent="primary" />
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <Card className="p-4 shadow-card">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-foreground">Revenue by day</h2>
            <span className="text-xs text-muted-foreground">Last {daily.length} days</span>
          </div>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={daily} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="rev" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--chart-1))" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="hsl(var(--chart-1))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickFormatter={(d) => d.slice(5)} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickFormatter={(v) => `$${v}`} />
                <Tooltip
                  contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
                  formatter={(v: number) => formatCurrency(v)}
                />
                <Area type="monotone" dataKey="revenue" stroke="hsl(var(--chart-1))" strokeWidth={2} fill="url(#rev)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-4 shadow-card">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-foreground">Revenue by transaction type</h2>
          </div>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={byType} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickFormatter={(v) => `$${v}`} />
                <Tooltip
                  contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
                  formatter={(v: number) => formatCurrency(v)}
                />
                <Bar dataKey="revenue" radius={[6, 6, 0, 0]}>
                  {byType.map((_, i) => (
                    <Cell key={i} fill={`hsl(var(--chart-${(i % 6) + 1}))`} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-4 shadow-card">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-foreground">Funnel comparison by revenue</h2>
          </div>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={byFunnel} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="funnel" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickFormatter={(v) => v.replace("_", " ")} />
                <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickFormatter={(v) => `$${v}`} />
                <Tooltip
                  contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
                  formatter={(v: number) => formatCurrency(v)}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="trial" stackId="a" fill="hsl(var(--chart-1))" name="Trial" />
                <Bar dataKey="upsell" stackId="a" fill="hsl(var(--chart-2))" name="Upsell" />
                <Bar dataKey="first_subscription" stackId="a" fill="hsl(var(--chart-3))" name="First Sub" />
                <Bar dataKey="renewal" stackId="a" fill="hsl(var(--chart-5))" name="Renewal" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-4 shadow-card">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-foreground">Trial → Upsell → First Subscription</h2>
          </div>
          <div className="space-y-3 py-2">
            {funnel.map((step, i) => (
              <div key={step.step}>
                <div className="mb-1 flex items-baseline justify-between text-xs">
                  <span className="font-medium text-foreground">{step.step}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {step.users} users · {step.conversion.toFixed(1)}%
                  </span>
                </div>
                <div className="h-8 w-full overflow-hidden rounded-md bg-secondary">
                  <div
                    className="h-full rounded-md transition-all"
                    style={{
                      width: `${Math.max(step.conversion, 4)}%`,
                      background: `hsl(var(--chart-${i + 1}))`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </AppLayout>
  );
}