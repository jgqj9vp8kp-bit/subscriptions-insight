export interface FunnelFoxSubscriptionRaw {
  id?: string;
  psp_id?: string;
  data?: Record<string, unknown>;
  profile_id?: string;
  customer_id?: string;
  user_id?: string;
  status?: string;
  renews?: boolean;
  sandbox?: boolean;
  created_at?: string;
  updated_at?: string;
  cancelled_at?: string | null;
  billing_interval?: string;
  billing_interval_count?: number;
  price?: number;
  currency?: string;
  price_usd?: number;
  payment_provider?: string;
  period_starts_at?: string;
  period_ends_at?: string;
  cancellation_reason?: string | null;
  funnel?: {
    title?: string;
    alias?: string;
    [key: string]: unknown;
  };
  session?: {
    id?: string;
    [key: string]: unknown;
  };
  profile?: {
    id?: string;
    email?: string;
    metadata?: {
      email?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  } | string;
  profileId?: string;
  profile_email?: string;
  email?: string;
  customer?: {
    id?: string;
    email?: string;
    [key: string]: unknown;
  } | string;
  customerEmail?: string;
  customerId?: string;
  customer_email?: string;
  user?: {
    id?: string;
    email?: string;
    [key: string]: unknown;
  } | string;
  metadata?: {
    email?: string;
    [key: string]: unknown;
  };
  product?: {
    id?: string;
    name?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface SubscriptionClean {
  subscription_id: string;
  psp_id: string;
  email: string | null;
  profile_id: string;
  status: string;
  renews: boolean | null;
  is_cancelled: boolean;
  cancelled_at: string | null;
  cancellation_source: "api_status_cancelled" | "api_renews_false" | null;
  cancellation_reason: string | null;
  is_active_now: boolean;
  created_at: string;
  updated_at: string;
  period_starts_at: string;
  period_ends_at: string;
  billing_interval: string;
  billing_interval_count: number | null;
  price_usd: number;
  currency: string;
  payment_provider: string;
  product_name: string;
  product_id: string;
  funnel_title: string;
  funnel_alias: string;
  session_id: string;
  raw: FunnelFoxSubscriptionRaw;
}

export interface FunnelFoxListResponse {
  data?: FunnelFoxSubscriptionRaw[];
  subscriptions?: FunnelFoxSubscriptionRaw[];
  pagination?: {
    has_more?: boolean;
    next_cursor?: string | null;
  };
}

export interface FunnelFoxProfileResponse {
  data?: unknown;
  profile?: unknown;
  [key: string]: unknown;
}
