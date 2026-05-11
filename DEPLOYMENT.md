# Deployment

## Supabase

- Project: `Musical_Lernapp`
- Project ref: `cqtavgzldzgdprcigotc`
- API URL: `https://cqtavgzldzgdprcigotc.supabase.co`
- Admin email: `kontakt@jakobklucke.de`
- Required frontend env:
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_ANON_KEY`

The database schema and Edge Functions live in `supabase/`. Regiebuch JSON files stay local in `private/scripts/` and are ignored by git. Run `npm run encrypt:scripts` with `SCRIPT_MASTER_KEY` only in a local shell when encrypted script seed data has to be regenerated.

`SCRIPT_MASTER_KEY` is read from a Supabase Function Secret when available. For connector-based setup it can also be stored in Supabase Vault via the service-role-only `get_script_master_key` RPC.

Required Supabase Auth settings:

- Enable Anonymous Sign-Ins for the player `Code + Name` login.
- Keep Email OTP/Magic Link enabled for the `/admin` login.
- Add `https://horrorladen-app.vercel.app/admin` to allowed redirect URLs if Supabase rejects the admin Magic Link redirect.

## Vercel

Create/import the Vercel project from GitHub repository `JakobKlucke/horrorladen-app`.

- Project: `horrorladen-app`
- Project ID: `prj_idjrKRs3m6ryH14pbLrQYwYj79Gd`
- Production URL: `https://horrorladen-app.vercel.app`
- Framework preset: Vite
- Build command: `npm run build`
- Output directory: `dist`
- Install command: `npm install`

Set these Production environment variables in Vercel:

```text
VITE_SUPABASE_URL=https://cqtavgzldzgdprcigotc.supabase.co
VITE_SUPABASE_ANON_KEY=<Supabase publishable or anon key>
```

After deployment, open the production URL and verify:

1. Code + Benutzername login screen appears.
2. A browser without a redeemed invite sees no Regiebuch.
3. A valid invite unlocks exactly its assigned Regiebuch.
4. `/admin` sends a Magic Link only for `kontakt@jakobklucke.de`.
5. DevTools Network does not show any public `scripts.json` or Regiebuch JSON file requests.
