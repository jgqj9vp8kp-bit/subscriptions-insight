# Subengine

## Local Environment

Create `.env.local` for local development:

```text
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

Restart `npm run dev` after changing env variables. Vite reads `.env.local` only when the dev server starts.

Only use the Supabase publishable anon key in frontend env. Never expose `service_role`, `sb_secret`, FunnelFox secrets, or other server-only credentials in `VITE_` variables.

## Deployment Checklist

### Lovable frontend env

```text
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your_publishable_anon_key
VITE_FUNNELFOX_MOCK=false
VITE_FUNNELFOX_PROXY_URL=https://your-vercel-domain.vercel.app/api/funnelfox/subscriptions
```

Production defaults must stay locked down:

- Do not set `VITE_ENABLE_LOCAL_AUTH=true`.
- Do not set `VITE_ENABLE_FUNNELFOX_DEBUG=true`.
- Do not expose `FUNNELFOX_SECRET` or any other server secret through `VITE_` variables.
- The temporary FunnelFox key input is hidden in production by default.
- Raw FunnelFox debug output is hidden in production by default.

### Vercel/serverless API env

```text
FUNNELFOX_SECRET=your_funnelfox_secret
```

### Supabase settings

- Disable public signup.
- Add the production Site URL.
- Add production Redirect URLs.
- Create allowed users manually in Supabase Auth.
- Use only the publishable anon key in the frontend.
