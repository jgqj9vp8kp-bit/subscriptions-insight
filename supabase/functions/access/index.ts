/* global Deno */

// access: the access admin API behind Admin → Access (plan §15-§17, §24;
// SHARED CONTRACT A). POST { action, ... } → { ok: true, ... } |
// { ok: false, error_code, error }. Members, roles, funnel scope, the audit log
// and the funnel picker; never the workspace data key.
//
// Access is decided by ACCESS_POLICY before the handler runs (admin.users.* /
// admin.roles.* / admin.audit.view; seeding role templates is Owner only;
// funnel-restricted members are refused). Writes go through the SECURITY
// DEFINER RPCs of 202610050002_access_core.sql with the caller as p_actor; they
// re-check permission and anti-escalation under the workspace lock and write
// the audit row in the same transaction. The logic lives in the pure,
// vitest-tested _shared/access/adminApi.ts.

import { serveWithAccess } from "../_shared/clickhouse/http.ts";
import { ACCESS_POLICY } from "../_shared/access/policies/access.ts";
import { accessAdminOnError, createAccessAdminHandler } from "../_shared/access/adminApi.ts";

serveWithAccess(ACCESS_POLICY, createAccessAdminHandler(), { onError: accessAdminOnError });
