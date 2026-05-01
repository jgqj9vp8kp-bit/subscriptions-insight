import type { FunnelFoxSubscriptionRaw, SubscriptionClean } from "@/types/subscriptions";

function valueString(value: unknown): string {
  return value == null ? "" : String(value);
}

function valueNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function centsNumber(value: unknown): number {
  const n = valueNumber(value);
  return n ? n / 100 : 0;
}

function nullableNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email || null;
}

export function normalizeProfileId(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).trim().replace(/^pro_/i, "");
}

function extractEmail(raw: FunnelFoxSubscriptionRaw): string | null {
  const profile = readRecord(raw.profile);
  const customer = readRecord(raw.customer);
  const user = readRecord(raw.user);
  const metadata = readRecord(raw.metadata);
  const profileMetadata = readRecord(profile.metadata);

  return (
    normalizeEmail(profile.email) ??
    normalizeEmail(raw.profile_email) ??
    normalizeEmail(raw.email) ??
    normalizeEmail(customer.email) ??
    normalizeEmail(raw.customerEmail) ??
    normalizeEmail(raw.customer_email) ??
    normalizeEmail(user.email) ??
    normalizeEmail(metadata.email) ??
    normalizeEmail(profileMetadata.email)
  );
}

export function extractSubscriptionProfileId(raw: FunnelFoxSubscriptionRaw): string {
  const data = readRecord(raw.data);
  const profile = readRecord(raw.profile);
  const customer = readRecord(raw.customer);
  const user = readRecord(raw.user);
  const dataProfile = readRecord(data.profile);
  const dataCustomer = readRecord(data.customer);
  const dataUser = readRecord(data.user);
  const candidate =
    raw.customer ??
    raw.customer_id ??
    raw.profile_id ??
    profile.id ??
    raw.profileId ??
    raw.customerId ??
    raw.user_id ??
    user.id ??
    data.customer ??
    data.customer_id ??
    data.profile_id ??
    dataProfile.id ??
    data.profileId ??
    data.customerId ??
    data.user_id ??
    dataUser.id ??
    customer.id ??
    dataCustomer.id ??
    (typeof raw.profile === "string" ? raw.profile : null);
  return normalizeProfileId(candidate);
}

export function extractProfileEmail(profileResponse: unknown): string | null {
  const root = readRecord(profileResponse);
  const data = readRecord(root.data);
  const profile = Object.keys(data).length ? data : readRecord(root.profile);
  const replies = readRecord(profile.replies);
  const metadata = readRecord(profile.metadata);
  const fields = readRecord(profile.fields);

  return (
    normalizeEmail(root.email) ??
    normalizeEmail(profile.email) ??
    normalizeEmail(data.email) ??
    normalizeEmail(replies.email) ??
    normalizeEmail(metadata.email) ??
    normalizeEmail(fields.email)
  );
}

function statusContains(status: string, needle: string): boolean {
  return status.toLowerCase().includes(needle);
}

export function normalizeSubscription(raw: FunnelFoxSubscriptionRaw): SubscriptionClean {
  const status = valueString(raw.status).toLowerCase();
  const renews = typeof raw.renews === "boolean" ? raw.renews : null;
  const cancelledByStatus = statusContains(status, "cancel");
  const cancelledByRenews = renews === false;
  const isCancelled = cancelledByStatus || cancelledByRenews;
  const periodEndsAt = valueString(raw.period_ends_at);
  const periodEndMs = periodEndsAt ? new Date(periodEndsAt).getTime() : Number.NaN;
  const periodEndsInFuture = Number.isFinite(periodEndMs) && periodEndMs > Date.now();
  const inactiveStatus = statusContains(status, "expired") || statusContains(status, "unpaid");
  const product = readRecord(raw.product);
  const funnel = readRecord(raw.funnel);
  const session = readRecord(raw.session);

  return {
    subscription_id: valueString(raw.id),
    psp_id: valueString(raw.psp_id),
    email: extractEmail(raw),
    profile_id: extractSubscriptionProfileId(raw),
    status,
    renews,
    is_cancelled: isCancelled,
    cancelled_at: valueString(raw.cancelled_at) || (isCancelled ? valueString(raw.updated_at) || null : null),
    cancellation_source: cancelledByStatus
      ? "api_status_cancelled"
      : cancelledByRenews
        ? "api_renews_false"
        : null,
    cancellation_reason: valueString(raw.cancellation_reason) || null,
    is_active_now: periodEndsInFuture && !inactiveStatus,
    created_at: valueString(raw.created_at),
    updated_at: valueString(raw.updated_at),
    period_starts_at: valueString(raw.period_starts_at),
    period_ends_at: periodEndsAt,
    billing_interval: valueString(raw.billing_interval),
    billing_interval_count: nullableNumber(raw.billing_interval_count),
    price_usd: centsNumber(raw.price_usd ?? raw.price),
    currency: valueString(raw.currency),
    payment_provider: valueString(raw.payment_provider),
    product_name: valueString(product.name),
    product_id: valueString(product.id),
    funnel_title: valueString(funnel.title),
    funnel_alias: valueString(funnel.alias),
    session_id: valueString(session.id),
    raw,
  };
}
