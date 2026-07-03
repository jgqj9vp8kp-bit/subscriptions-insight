import { useCallback, useEffect, useMemo, useState } from "react";
import { Inbox, Loader2, MailCheck, RefreshCw, Search } from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { useToast } from "@/hooks/use-toast";
import {
  SUPPORT_INTENTS,
  filterSupportMessages,
  listSupportMessages,
  summarizeSupportMessages,
  syncSupportMail,
  uniqueSupportValues,
  type SupportIntent,
  type SupportMessage,
  type SupportMessageFilters,
  type SyncSupportMailSummary,
} from "@/services/supportInbox";

const INTENT_LABELS: Record<SupportIntent, string> = {
  refund_request: "Refund request",
  cancel_subscription: "Cancel request",
  payment_problem: "Payment problem",
  access_problem: "Access problem",
  general_support: "General support",
  unknown: "Unknown",
};

const EMPTY_FILTERS: SupportMessageFilters = {
  dateFrom: "",
  dateTo: "",
  intent: "all",
  campaignPath: "",
  campaignId: "",
  mediaBuyer: "",
  country: "",
  cardType: "",
  matchStatus: "all",
  search: "",
};

function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatMoney(value: number | null | undefined): string {
  if (value == null) return "-";
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <Card className="p-4 shadow-card">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-foreground">{value}</p>
    </Card>
  );
}

function BreakdownTable({ title, rows }: { title: string; rows: Array<{ label: string; count: number }> }) {
  return (
    <Card className="p-4 shadow-card">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <div className="mt-3 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Segment</TableHead>
              <TableHead className="text-right">Messages</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length ? rows.map((row) => (
              <TableRow key={row.label}>
                <TableCell className="text-sm">{row.label}</TableCell>
                <TableCell className="text-right font-mono text-sm">{row.count}</TableCell>
              </TableRow>
            )) : (
              <TableRow>
                <TableCell colSpan={2} className="h-20 text-center text-muted-foreground">No data</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}

function countBy(messages: SupportMessage[], getter: (message: SupportMessage) => string | null | undefined) {
  const counts = new Map<string, number>();
  messages.forEach((message) => {
    const label = getter(message) || "Unknown";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  });
  return Array.from(counts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export default function SupportPage() {
  const { toast } = useToast();
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [filters, setFilters] = useState<SupportMessageFilters>(EMPTY_FILTERS);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<SyncSupportMailSummary | null>(null);
  const [selected, setSelected] = useState<SupportMessage | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setMessages(await listSupportMessages());
    } catch (error) {
      toast({
        title: "Could not load support messages",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onSync() {
    setSyncing(true);
    try {
      const summary = await syncSupportMail();
      setLastSync(summary);
      await load();
      toast({ title: "Mail.ru inbox synced", description: `${summary.synced} messages processed.` });
    } catch (error) {
      toast({
        title: "Support sync failed",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSyncing(false);
    }
  }

  const filtered = useMemo(() => filterSupportMessages(messages, filters), [messages, filters]);
  const summary = useMemo(() => summarizeSupportMessages(filtered), [filtered]);
  const options = useMemo(() => ({
    campaignPaths: uniqueSupportValues(messages, "campaign_path"),
    campaignIds: uniqueSupportValues(messages, "campaign_id"),
    mediaBuyers: uniqueSupportValues(messages, "media_buyer"),
    countries: uniqueSupportValues(messages, "country_code"),
    cardTypes: uniqueSupportValues(messages, "card_type"),
  }), [messages]);
  const analytics = useMemo(() => ({
    byIntent: countBy(filtered, (message) => INTENT_LABELS[message.detected_intent]),
    refundByCohort: countBy(filtered.filter((message) => message.detected_intent === "refund_request"), (message) => message.cohort_id ?? message.cohort_date),
    cancelByCohort: countBy(filtered.filter((message) => message.detected_intent === "cancel_subscription"), (message) => message.cohort_id ?? message.cohort_date),
    byMediaBuyer: countBy(filtered, (message) => message.media_buyer),
    refundByCampaignId: countBy(filtered.filter((message) => message.detected_intent === "refund_request"), (message) => message.campaign_id),
    unmatched: filtered.filter((message) => !message.matched_user_id),
  }), [filtered]);

  const updateFilter = <K extends keyof SupportMessageFilters>(key: K, value: SupportMessageFilters[K]) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };

  return (
    <AppLayout
      title="Support Inbox"
      description="Mail.ru support mailbox synced with user/cohort analytics."
      actions={
        <Button type="button" variant="outline" size="sm" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </Button>
      }
    >
      <div className="space-y-4">
        <Card className="p-4 shadow-card">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Inbox className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-foreground">Mail.ru Support Sync</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Reads support@azora-astro.com via IMAP in a Supabase Edge Function. Credentials stay in Edge Function secrets.
                </p>
              </div>
            </div>
            <Button type="button" onClick={onSync} disabled={syncing}>
              {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <MailCheck className="h-4 w-4" />}
              Sync Mail.ru Inbox
            </Button>
          </div>
          <div className="mt-4 grid gap-3 text-xs sm:grid-cols-3 lg:grid-cols-6">
            <div><span className="text-muted-foreground">Last sync</span><div className="font-medium">{formatDate(lastSync?.latest_received_at)}</div></div>
            <div><span className="text-muted-foreground">Inserted</span><div className="font-medium">{lastSync?.inserted ?? "-"}</div></div>
            <div><span className="text-muted-foreground">Updated</span><div className="font-medium">{lastSync?.updated ?? "-"}</div></div>
            <div><span className="text-muted-foreground">Matched users</span><div className="font-medium">{lastSync?.matched_users ?? "-"}</div></div>
            <div><span className="text-muted-foreground">Unmatched</span><div className="font-medium">{lastSync?.unmatched ?? "-"}</div></div>
            <div><span className="text-muted-foreground">Processed</span><div className="font-medium">{lastSync?.synced ?? "-"}</div></div>
          </div>
        </Card>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <StatCard label="Total Messages" value={summary.totalMessages} />
          <StatCard label="Refund Requests" value={summary.refundRequests} />
          <StatCard label="Cancel Requests" value={summary.cancelRequests} />
          <StatCard label="Payment Problems" value={summary.paymentProblems} />
          <StatCard label="Matched Users" value={summary.matchedUsers} />
          <StatCard label="Unmatched Messages" value={summary.unmatchedMessages} />
        </div>

        <Card className="p-4 shadow-card">
          <div className="mb-3 flex items-center gap-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">Filters</h2>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="space-y-1">
              <Label>Date from</Label>
              <Input type="date" value={filters.dateFrom ?? ""} onChange={(event) => updateFilter("dateFrom", event.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Date to</Label>
              <Input type="date" value={filters.dateTo ?? ""} onChange={(event) => updateFilter("dateTo", event.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Intent</Label>
              <Select value={filters.intent ?? "all"} onValueChange={(value) => updateFilter("intent", value as SupportIntent | "all")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All intents</SelectItem>
                  {SUPPORT_INTENTS.map((intent) => <SelectItem key={intent} value={intent}>{INTENT_LABELS[intent]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Matched</Label>
              <Select value={filters.matchStatus ?? "all"} onValueChange={(value) => updateFilter("matchStatus", value as "all" | "matched" | "unmatched")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="matched">Matched</SelectItem>
                  <SelectItem value="unmatched">Unmatched</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Search</Label>
              <Input value={filters.search ?? ""} onChange={(event) => updateFilter("search", event.target.value)} placeholder="Email or subject" />
            </div>
            {[
              ["campaignPath", "Campaign path", options.campaignPaths],
              ["campaignId", "Campaign ID", options.campaignIds],
              ["mediaBuyer", "Media buyer", options.mediaBuyers],
              ["country", "Country", options.countries],
              ["cardType", "Card type", options.cardTypes],
            ].map(([key, label, values]) => (
              <div key={key as string} className="space-y-1">
                <Label>{label as string}</Label>
                <Select value={(filters[key as keyof SupportMessageFilters] as string) || "all"} onValueChange={(value) => updateFilter(key as keyof SupportMessageFilters, (value === "all" ? "" : value) as never)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    {(values as string[]).map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
        </Card>

        <Card className="shadow-card">
          <div className="border-b border-border p-4">
            <h2 className="text-sm font-semibold text-foreground">Support Messages</h2>
            <p className="mt-1 text-xs text-muted-foreground">{filtered.length} of {messages.length} messages</p>
          </div>
          <div className="overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Received At</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>Intent</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Cohort Date</TableHead>
                  <TableHead>Campaign Path</TableHead>
                  <TableHead>Campaign ID</TableHead>
                  <TableHead>Media Buyer</TableHead>
                  <TableHead>Country</TableHead>
                  <TableHead>Card Type</TableHead>
                  <TableHead>Subscription Status</TableHead>
                  <TableHead>Refund Status</TableHead>
                  <TableHead className="text-right">Amount Paid</TableHead>
                  <TableHead className="text-right">Amount Refunded</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((message) => (
                  <TableRow key={message.id} className="cursor-pointer" onClick={() => setSelected(message)}>
                    <TableCell className="whitespace-nowrap text-xs">{formatDate(message.received_at)}</TableCell>
                    <TableCell className="max-w-[180px] truncate text-xs">{message.from_email ?? "-"}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{INTENT_LABELS[message.detected_intent]}</TableCell>
                    <TableCell className="max-w-[260px] truncate text-xs">{message.subject ?? "-"}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{message.cohort_date ?? "-"}</TableCell>
                    <TableCell className="max-w-[180px] truncate text-xs">{message.campaign_path ?? "-"}</TableCell>
                    <TableCell className="max-w-[160px] truncate font-mono text-xs">{message.campaign_id ?? "-"}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{message.media_buyer ?? "-"}</TableCell>
                    <TableCell className="text-xs">{message.country_code ?? "-"}</TableCell>
                    <TableCell className="text-xs">{message.card_type ?? "-"}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{message.subscription_status ?? "-"}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{message.refund_status ?? "-"}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{formatMoney(message.amount_paid)}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{formatMoney(message.amount_refunded)}</TableCell>
                  </TableRow>
                ))}
                {!filtered.length && (
                  <TableRow>
                    <TableCell colSpan={14} className="h-28 text-center text-muted-foreground">
                      {loading ? "Loading support messages..." : "No support messages match the current filters"}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <BreakdownTable title="Messages by intent" rows={analytics.byIntent} />
          <BreakdownTable title="Refund requests by cohort" rows={analytics.refundByCohort} />
          <BreakdownTable title="Cancel requests by cohort" rows={analytics.cancelByCohort} />
          <BreakdownTable title="Messages by media buyer" rows={analytics.byMediaBuyer} />
          <BreakdownTable title="Refund requests by campaign_id" rows={analytics.refundByCampaignId} />
          <BreakdownTable title="Unmatched messages list" rows={analytics.unmatched.map((message) => ({ label: message.from_email || message.subject || message.message_id, count: 1 }))} />
        </div>
      </div>

      <Dialog open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-auto">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle>{selected.subject || "Support message"}</DialogTitle>
                <DialogDescription>
                  Support request details with matched user, cohort, campaign, payment, and refund context.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-4 text-sm">
                <div className="grid gap-2 sm:grid-cols-2">
                  <div><span className="text-muted-foreground">From</span><div>{selected.from_email ?? "-"}</div></div>
                  <div><span className="text-muted-foreground">Received</span><div>{formatDate(selected.received_at)}</div></div>
                  <div><span className="text-muted-foreground">Intent</span><div>{INTENT_LABELS[selected.detected_intent]}</div></div>
                  <div><span className="text-muted-foreground">Matched user</span><div>{selected.matched_user_email ?? "Unmatched"}</div></div>
                </div>
                <div className="rounded-md border border-border p-3">
                  <h3 className="text-xs font-semibold text-muted-foreground">Message Body</h3>
                  <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">{selected.body_text || "No plain text body available."}</p>
                </div>
                <div className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-2">
                  <div><span className="text-muted-foreground">Cohort</span><div>{selected.cohort_id ?? "-"}</div></div>
                  <div><span className="text-muted-foreground">Campaign ID</span><div>{selected.campaign_id ?? "-"}</div></div>
                  <div><span className="text-muted-foreground">Campaign Path</span><div>{selected.campaign_path ?? "-"}</div></div>
                  <div><span className="text-muted-foreground">Media Buyer</span><div>{selected.media_buyer ?? "-"}</div></div>
                  <div><span className="text-muted-foreground">Country / Card</span><div>{selected.country_code ?? "-"} / {selected.card_type ?? "-"}</div></div>
                  <div><span className="text-muted-foreground">Subscription / Refund</span><div>{selected.subscription_status ?? "-"} / {selected.refund_status ?? "-"}</div></div>
                  <div><span className="text-muted-foreground">Amount Paid</span><div>{formatMoney(selected.amount_paid)}</div></div>
                  <div><span className="text-muted-foreground">Amount Refunded</span><div>{formatMoney(selected.amount_refunded)}</div></div>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
