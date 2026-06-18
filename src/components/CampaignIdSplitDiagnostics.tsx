import { useMemo, useState } from "react";
import { Split } from "lucide-react";
import { Card } from "@/components/ui/card";
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
import { useDataStore } from "@/store/dataStore";
import {
  analyzeCampaignIdSplits,
  RECOMMENDATION_GROUP_BY_ID,
  type CampaignIdSplitFilters,
} from "@/services/campaignIdSplitDiagnostics";

const MEDIA_BUYERS = ["all", "Ivan", "Artem A", "Artem D", "Unknown"] as const;

const DEFAULT_FILTERS = {
  date_from: "",
  date_to: "",
  media_buyer: "all",
  campaign_path: "",
};

function formatInt(value: number): string {
  return value.toLocaleString("en-US");
}

function formatPct(value: number): string {
  return `${value.toFixed(2)}%`;
}

function SummaryCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold text-foreground">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function CampaignIdSplitDiagnostics() {
  const transactions = useDataStore((state) => state.transactions);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);

  const serviceFilters = useMemo<CampaignIdSplitFilters>(
    () => ({
      date_from: filters.date_from || null,
      date_to: filters.date_to || null,
      media_buyer: filters.media_buyer === "all" ? null : filters.media_buyer,
      campaign_path: filters.campaign_path.trim() || null,
    }),
    [filters],
  );

  const analysis = useMemo(
    () => analyzeCampaignIdSplits(transactions, serviceFilters),
    [transactions, serviceFilters],
  );

  const splitRows = useMemo(() => analysis.rows.filter((row) => row.is_split), [analysis.rows]);
  const isGroupByIdRecommendation = analysis.recommendation === RECOMMENDATION_GROUP_BY_ID;

  return (
    <Card className="p-4 shadow-card">
      <div className="flex items-center gap-2">
        <Split className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold text-foreground">Campaign ID Split Diagnostics</h2>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Aggregate-only check of how often one <span className="font-mono">campaign_id</span> spans multiple
        <span className="font-mono"> campaign_path</span> / <span className="font-mono">funnel</span> combinations.
        Users are anchored to their first successful trial, mirroring the Export API grouping. No emails or raw
        payloads are read.
      </p>

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">date_from (first trial)</Label>
          <Input
            type="date"
            value={filters.date_from}
            onChange={(event) => setFilters((current) => ({ ...current, date_from: event.target.value }))}
          />
        </div>
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">date_to (first trial)</Label>
          <Input
            type="date"
            value={filters.date_to}
            onChange={(event) => setFilters((current) => ({ ...current, date_to: event.target.value }))}
          />
        </div>
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">media_buyer</Label>
          <Select
            value={filters.media_buyer}
            onValueChange={(value) => setFilters((current) => ({ ...current, media_buyer: value }))}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MEDIA_BUYERS.map((buyer) => (
                <SelectItem key={buyer} value={buyer}>
                  {buyer === "all" ? "All" : buyer}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">campaign_path</Label>
          <Input
            value={filters.campaign_path}
            placeholder="soulmate-reading"
            onChange={(event) => setFilters((current) => ({ ...current, campaign_path: event.target.value }))}
          />
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <SummaryCard label="Total Campaign IDs" value={formatInt(analysis.total_campaign_ids)} />
        <SummaryCard label="Split Campaign IDs" value={formatInt(analysis.split_campaign_ids)} hint="> 1 path/funnel combo" />
        <SummaryCard label="Total Trial Users" value={formatInt(analysis.total_trial_users)} />
        <SummaryCard label="Split Traffic Share" value={formatPct(analysis.split_traffic_share)} hint={`${formatInt(analysis.split_trial_users)} trial users`} />
        <SummaryCard label="Unknown Trial Users" value={formatInt(analysis.unknown_trial_users)} hint="excluded from split share" />
      </div>

      <div
        className={`mt-4 rounded-md border p-3 text-xs ${
          isGroupByIdRecommendation
            ? "border-success/30 bg-success/10 text-foreground"
            : "border-warning/30 bg-warning/10 text-foreground"
        }`}
      >
        <span className="font-medium">{analysis.recommendation}</span>
      </div>

      <div className="mt-4 overflow-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Campaign ID</TableHead>
              <TableHead className="text-right">Number of Paths</TableHead>
              <TableHead className="text-right">Number of Funnels</TableHead>
              <TableHead className="text-right">Trial Users</TableHead>
              <TableHead className="text-right">Share of Traffic</TableHead>
              <TableHead>Paths</TableHead>
              <TableHead>Funnels</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {splitRows.length ? (
              splitRows.map((row) => (
                <TableRow key={row.campaign_id}>
                  <TableCell className="font-mono text-xs">{row.campaign_id_label}</TableCell>
                  <TableCell className="text-right">{formatInt(row.number_of_paths)}</TableCell>
                  <TableCell className="text-right">{formatInt(row.number_of_funnels)}</TableCell>
                  <TableCell className="text-right">{formatInt(row.trial_users)}</TableCell>
                  <TableCell className="text-right">{formatPct(row.traffic_share)}</TableCell>
                  <TableCell className="max-w-[220px] truncate text-xs text-muted-foreground" title={row.paths.join(", ")}>
                    {row.paths.join(", ")}
                  </TableCell>
                  <TableCell className="max-w-[180px] truncate text-xs text-muted-foreground" title={row.funnels.join(", ")}>
                    {row.funnels.join(", ")}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  No campaign IDs span multiple paths or funnels for the current filters.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}
