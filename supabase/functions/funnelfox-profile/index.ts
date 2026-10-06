/* global Deno */

// funnelfox-profile: proxy of FunnelFox GET /profiles/{id} for the data owner's
// Import tooling. By default it returns only the profile id and the resolved
// email (P0-5).
//
// Access (policies/funnelfox-profile.ts): rawOnly + admin.sync.run; the `debug`
// flag is its own action (profile_debug) that also needs admin.diagnostics.view,
// and still returns the rich body only when FUNNELFOX_DEBUG is enabled
// server-side. The gate authenticates before anything runs; CORS, OPTIONS and
// the GET / POST method check come from it. Parameters are read exactly as
// before (query string first, then body keys).

import { serveWithAccess } from "../_shared/clickhouse/http.ts";
import { FUNNELFOX_PROFILE_POLICY } from "../_shared/access/policies/funnelfox-profile.ts";
import {
  FunnelFoxEdgeError,
  fetchFunnelFox,
  funnelFoxErrorResponse,
  funnelFoxFailure,
  funnelFoxRequestParams,
  getFunnelFoxSecret,
  isFunnelFoxDebugEnabled,
  profileDebugBody,
  profileMinimalBody,
} from "../_shared/funnelfox.ts";

serveWithAccess(FUNNELFOX_PROFILE_POLICY, async ({ ctx, action, body, url }) => {
  const params = funnelFoxRequestParams(url, body);
  const profileId = params.get("id")?.trim();
  // Rich profile payload is exposed only when the server explicitly enables debug AND the caller
  // opts in (the profile_debug action). In production (FUNNELFOX_DEBUG unset) this is always false (P0-5).
  const debug = isFunnelFoxDebugEnabled() && action === "profile_debug";

  if (!profileId) {
    return funnelFoxFailure(ctx, 400, { error: "FunnelFox profile id is required." });
  }

  const secret = getFunnelFoxSecret();
  if (!secret) {
    return funnelFoxFailure(ctx, 500, { error: "FunnelFox sync is not configured." });
  }

  try {
    const upstream = await fetchFunnelFox(`/profiles/${encodeURIComponent(profileId)}`, secret);
    if (!upstream.ok) {
      return funnelFoxFailure(ctx, upstream.status, { error: "FunnelFox profile request failed." });
    }

    return debug
      ? profileDebugBody(profileId, upstream.payload)
      : profileMinimalBody(profileId, upstream.payload);
  } catch (error) {
    if (error instanceof FunnelFoxEdgeError) throw error;
    return funnelFoxFailure(ctx, 502, { error: "FunnelFox profile request failed." });
  }
}, { onError: funnelFoxErrorResponse });
