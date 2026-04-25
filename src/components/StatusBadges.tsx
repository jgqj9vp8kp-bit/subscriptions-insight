import { cn } from "@/lib/utils";
import type { TransactionStatus, TransactionType } from "@/services/types";

const TYPE_LABELS: Record<TransactionType, string> = {
  trial: "Trial",
  upsell: "Upsell",
  first_subscription: "First Sub",
  renewal: "Renewal",
  failed_payment: "Failed",
  refund: "Refund",
  chargeback: "Chargeback",
  unknown: "Unknown",
};

const TYPE_STYLES: Record<TransactionType, string> = {
  trial: "bg-primary/10 text-primary",
  upsell: "bg-accent/10 text-accent",
  first_subscription: "bg-success/10 text-success",
  renewal: "bg-chart-5/10 text-chart-5",
  failed_payment: "bg-destructive/10 text-destructive",
  refund: "bg-warning/15 text-warning",
  chargeback: "bg-destructive/15 text-destructive",
  unknown: "bg-muted text-muted-foreground",
};

const STATUS_STYLES: Record<TransactionStatus, string> = {
  success: "bg-success/10 text-success",
  failed: "bg-destructive/10 text-destructive",
  refunded: "bg-warning/15 text-warning",
  chargeback: "bg-destructive/15 text-destructive",
};

export function TypeBadge({ type }: { type: TransactionType }) {
  return (
    <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium", TYPE_STYLES[type])}>
      {TYPE_LABELS[type]}
    </span>
  );
}

export function StatusBadge({ status }: { status: TransactionStatus }) {
  return (
    <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium capitalize", STATUS_STYLES[status])}>
      {status}
    </span>
  );
}

export function FunnelBadge({ funnel }: { funnel: string }) {
  return (
    <span className="inline-flex items-center rounded-md bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground capitalize">
      {funnel.replace("_", " ")}
    </span>
  );
}