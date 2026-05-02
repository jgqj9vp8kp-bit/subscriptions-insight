/* global process */

const FUNNELFOX_SUBSCRIPTIONS_URL = "https://api.funnelfox.io/public/v1/subscriptions";
const FUNNELFOX_PROFILES_URL = "https://api.funnelfox.io/public/v1/profiles";

type ProxyOptions = {
  cursor?: string;
  debug?: boolean;
  secret?: string;
};

type ProfileProxyOptions = {
  profileId: string;
  secret?: string;
};

type SubscriptionDetailsProxyOptions = {
  subscriptionId: string;
  secret?: string;
};

type ProxyResult = {
  status: number;
  body: unknown;
};

function extractRows(payload: unknown): unknown[] {
  if (!payload || typeof payload !== "object") return [];

  const record = payload as { data?: unknown; subscriptions?: unknown };
  if (Array.isArray(record.data)) return record.data;
  if (Array.isArray(record.subscriptions)) return record.subscriptions;
  return [];
}

function valueType(value: unknown): string {
  if (value == null) return "missing";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function safeEmailPreview(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const [local, domain] = trimmed.split("@");
  if (!local || !domain) return "***";
  return `${local.slice(0, 2)}***@${domain}`;
}

function objectKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).filter((key) => {
    const normalized = key.toLowerCase();
    return normalized.includes("email") || normalized.includes("profile") || normalized.includes("customer") || normalized.includes("user") || normalized.includes("metadata");
  });
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => readRecord(current)[key], value);
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email || null;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized.includes("secret") ||
    normalized.includes("token") ||
    normalized.includes("password") ||
    normalized.includes("authorization") ||
    normalized.includes("card") ||
    normalized.includes("pan") ||
    normalized.includes("cvv") ||
    normalized.includes("cvc") ||
    normalized.includes("payment")
  );
}

function sanitizeDebugValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeDebugValue);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !isSensitiveKey(key))
      .map(([key, entry]) => [key, sanitizeDebugValue(entry)]),
  );
}

function sanitizeApiValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeApiValue);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => {
        const normalized = key.toLowerCase();
        return !(
          normalized.includes("secret") ||
          normalized.includes("token") ||
          normalized.includes("password") ||
          normalized.includes("authorization") ||
          normalized.includes("card") ||
          normalized.includes("pan") ||
          normalized.includes("cvv") ||
          normalized.includes("cvc")
        );
      })
      .map(([key, entry]) => [key, sanitizeApiValue(entry)]),
  );
}

function sampleEmailFields(payload: unknown) {
  const row = extractRows(payload)[0];
  const root = readRecord(row);
  const profile = readRecord(root.profile);
  const customer = readRecord(root.customer);
  const user = readRecord(root.user);
  const metadata = readRecord(root.metadata);
  const profileMetadata = readRecord(profile.metadata);

  return {
    root_keys: objectKeys(row),
    profile_keys: objectKeys(root.profile),
    customer_keys: objectKeys(root.customer),
    user_keys: objectKeys(root.user),
    metadata_keys: objectKeys(root.metadata),
    profile_metadata_keys: objectKeys(profile.metadata),
    candidates: {
      profile_id: { type: valueType(root.profile_id) },
      "profile.id": { type: valueType(profile.id) },
      profileId: { type: valueType(root.profileId) },
      profile: { type: valueType(root.profile) },
      "profile.email": { type: valueType(profile.email), preview: safeEmailPreview(profile.email) },
      profile_email: { type: valueType(root.profile_email), preview: safeEmailPreview(root.profile_email) },
      email: { type: valueType(root.email), preview: safeEmailPreview(root.email) },
      "customer.email": { type: valueType(customer.email), preview: safeEmailPreview(customer.email) },
      customerEmail: { type: valueType(root.customerEmail), preview: safeEmailPreview(root.customerEmail) },
      customer_email: { type: valueType(root.customer_email), preview: safeEmailPreview(root.customer_email) },
      "user.email": { type: valueType(user.email), preview: safeEmailPreview(user.email) },
      "metadata.email": { type: valueType(metadata.email), preview: safeEmailPreview(metadata.email) },
      "profile.metadata.email": { type: valueType(profileMetadata.email), preview: safeEmailPreview(profileMetadata.email) },
    },
  };
}

function emailCoverage(payload: unknown) {
  const rows = extractRows(payload);
  const subscriptionsWithEmail = rows.filter((row) => {
    const root = readRecord(row);
    const profile = readRecord(root.profile);
    const customer = readRecord(root.customer);
    const user = readRecord(root.user);
    const metadata = readRecord(root.metadata);
    const profileMetadata = readRecord(profile.metadata);

    return [
      profile.email,
      root.profile_email,
      root.email,
      customer.email,
      root.customerEmail,
      root.customer_email,
      user.email,
      metadata.email,
      profileMetadata.email,
    ].some((value) => typeof value === "string" && value.trim());
  }).length;
  const totalSubscriptions = rows.length;
  const subscriptionsMissingEmail = totalSubscriptions - subscriptionsWithEmail;

  return {
    total_subscriptions: totalSubscriptions,
    subscriptions_with_email: subscriptionsWithEmail,
    subscriptions_missing_email: subscriptionsMissingEmail,
    email_coverage_percent: totalSubscriptions ? (subscriptionsWithEmail / totalSubscriptions) * 100 : 0,
  };
}

function debugBody(secretExists: boolean, canCallFunnelFox: boolean, status?: number, payload?: unknown) {
  const coverage = payload ? emailCoverage(payload) : {
    total_subscriptions: 0,
    subscriptions_with_email: 0,
    subscriptions_missing_email: 0,
    email_coverage_percent: 0,
  };

  return {
    secret_exists: secretExists,
    can_call_funnelfox: canCallFunnelFox,
    funnelfox_status: status ?? null,
    subscription_count: coverage.total_subscriptions,
    ...coverage,
    sample_email_fields: payload ? sampleEmailFields(payload) : null,
  };
}

function profileDebugBody(profileId: string, payload: unknown) {
  const profile = readRecord(readRecord(payload).data ?? payload);
  const checkedPaths = [
    "data.email",
    "email",
    "metadata.email",
    "replies.email",
    "fields.email",
    "attributes.email",
    "contact.email",
  ];
  const emailLikeFieldsFound = checkedPaths
    .map((path) => ({ path, value: normalizeEmail(readPath(payload, path) ?? readPath(profile, path)) }))
    .filter((item) => item.value);
  const detectedEmail = emailLikeFieldsFound[0]?.value ?? null;

  return {
    profile_id: profileId,
    raw_profile_keys: Object.keys(profile),
    detected_email: detectedEmail,
    checked_paths: checkedPaths,
    email_like_fields_found: emailLikeFieldsFound,
    profile: sanitizeDebugValue(profile),
  };
}

export async function handleFunnelFoxSubscriptions(options: ProxyOptions): Promise<ProxyResult> {
  const secret = options.secret ?? process.env.FUNNELFOX_SECRET;
  const debug = Boolean(options.debug);

  if (!secret) {
    return {
      status: debug ? 200 : 500,
      body: debug
        ? debugBody(false, false)
        : { error: "FunnelFox sync is not configured." },
    };
  }

  const url = new URL(FUNNELFOX_SUBSCRIPTIONS_URL);
  if (options.cursor) url.searchParams.set("cursor", options.cursor);

  try {
    const upstream = await fetch(url.toString(), {
      headers: {
        "Fox-Secret": secret,
        Accept: "application/json",
      },
    });

    let payload: unknown = null;
    try {
      payload = await upstream.json();
    } catch {
      payload = null;
    }

    if (debug) {
      return {
        status: 200,
        body: debugBody(true, upstream.ok, upstream.status, payload),
      };
    }

    if (!upstream.ok) {
      return {
        status: upstream.status,
        body: { error: "FunnelFox API request failed." },
      };
    }

    return { status: 200, body: payload };
  } catch {
    return {
      status: debug ? 200 : 502,
      body: debug
        ? debugBody(true, false)
        : { error: "FunnelFox API request failed." },
    };
  }
}

export async function handleFunnelFoxSubscriptionDetails(options: SubscriptionDetailsProxyOptions): Promise<ProxyResult> {
  const secret = options.secret ?? process.env.FUNNELFOX_SECRET;
  const subscriptionId = options.subscriptionId.trim();

  if (!subscriptionId) {
    return {
      status: 400,
      body: { error: "FunnelFox subscription id is required." },
    };
  }

  if (!secret) {
    return {
      status: 500,
      body: { error: "FunnelFox sync is not configured." },
    };
  }

  const url = new URL(`${FUNNELFOX_SUBSCRIPTIONS_URL}/${encodeURIComponent(subscriptionId)}`);

  try {
    const upstream = await fetch(url.toString(), {
      headers: {
        "Fox-Secret": secret,
        Accept: "application/json",
      },
    });

    let payload: unknown = null;
    try {
      payload = await upstream.json();
    } catch {
      payload = null;
    }

    if (!upstream.ok) {
      return {
        status: upstream.status,
        body: { error: "FunnelFox subscription details request failed." },
      };
    }

    return { status: 200, body: payload };
  } catch {
    return {
      status: 502,
      body: { error: "FunnelFox subscription details request failed." },
    };
  }
}

export async function handleFunnelFoxProfile(options: ProfileProxyOptions): Promise<ProxyResult> {
  const secret = options.secret ?? process.env.FUNNELFOX_SECRET;
  const profileId = options.profileId.trim();

  if (!profileId) {
    return {
      status: 400,
      body: { error: "FunnelFox profile id is required." },
    };
  }

  if (!secret) {
    return {
      status: 500,
      body: { error: "FunnelFox sync is not configured." },
    };
  }

  const url = new URL(`${FUNNELFOX_PROFILES_URL}/${encodeURIComponent(profileId)}`);

  try {
    const upstream = await fetch(url.toString(), {
      headers: {
        "Fox-Secret": secret,
        Accept: "application/json",
      },
    });

    let payload: unknown = null;
    try {
      payload = await upstream.json();
    } catch {
      payload = null;
    }

    if (!upstream.ok) {
      return {
        status: upstream.status,
        body: { error: "FunnelFox profile request failed." },
      };
    }

    return { status: 200, body: payload };
  } catch {
    return {
      status: 502,
      body: { error: "FunnelFox profile request failed." },
    };
  }
}

export async function handleFunnelFoxProfileDebug(options: ProfileProxyOptions): Promise<ProxyResult> {
  const result = await handleFunnelFoxProfile(options);
  if (result.status !== 200) return result;

  return {
    status: 200,
    body: profileDebugBody(options.profileId.trim(), result.body),
  };
}
