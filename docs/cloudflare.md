# Cloudflare setup

The setup wizard creates everything on your Cloudflare account and deploys the Worker. Run it from `worker/` on any
computer with Node 22+ (it doesn't need to run on your servers):

```sh
cd worker && npm install
cp setup/answers.example.json my-answers.json      # fill it in; anything missing is asked for
npm run setup -- --answers my-answers.json
```

## Before you start

1. Your domain is on Cloudflare (any plan), and your account has the **Workers Paid** plan.
2. **Zero Trust** is set up once: dashboard → *Zero Trust* → choose a team name and the Free plan. This creates your
   login page `https://<team>.cloudflareaccess.com`.
3. An **API token** (dashboard → My Profile → API Tokens → Create Token → Custom) with:
   *Account*: Workers Scripts **Edit**, D1 **Edit**, Access: Apps and Policies **Edit**, Access: Organizations,
   Identity Providers, and Groups **Edit**, Account Settings **Read**; *Zone* (your domain): Workers Routes **Edit**,
   DNS **Edit**, Zone Settings **Read** (for the TLS check; **Edit** if you want it to fix them). You can split the
   Access permissions into a second token (`access_api_token`).
4. The values printed by the storage installer (and the download-box installer, if you have one): point
   `storage_values_file` / `box_values_file` at their `cloudflare-values.txt`, or paste the values into `storage`.
5. A TMDB API Read Access Token (free; see [below](#tmdb-token)).

### TMDB token

watchbox gets titles, posters, cast, episodes and age ratings from [TMDB](https://www.themoviedb.org). The key is free:

1. Create an account at [themoviedb.org/signup](https://www.themoviedb.org/signup) and confirm your email.
2. Open [Settings → API](https://www.themoviedb.org/settings/api) and request an API key: choose *Developer*, accept the
   terms, and fill in the short form (personal, non-commercial use is fine).
3. Copy the **API Read Access Token** (the long one starting with `eyJ`, not the 32-character API Key).

The same token also goes to the download box (`--tmdb-token`), where it gives the Find page its posters and ratings.

<sub>watchbox uses the TMDB API but is not endorsed or certified by TMDB.</sub>

## What it does

1. checks the token, finds your account and the zone of `hostname`,
2. checks the zone's TLS settings: warns if TLS older than 1.2 is accepted or "Always Use HTTPS" is off (and fixes
   both with `"fix_tls": true`; it affects the whole domain),
3. creates the D1 database,
4. enables one-time-PIN login in Zero Trust and creates two Access applications: `<name>: admin` for
   `https://<hostname>/admin*` (only `admin_email`) and `<name>: guests` for `/me*` (any email; the Worker then admits
   only people you've added),
5. writes `worker/wrangler.<name>.jsonc` (keep it: re-running setup reads it, and it holds your server id),
6. applies the database migrations, deploys the Worker with custom domains for `hostname` (and `<sub>-cc/dl/rs` for the
   download box's tools), and sets the secrets,
7. creates your Jellyfin login (`owner_user`; the password is printed once) and checks the server answers.

Run it again any time (new release, changed answers): it finds what exists by name and updates it. To remove an
install: `npm run setup -- --answers my-answers.json --teardown` (deletes the Worker, database, Access apps and
custom domains of that name; your zone and the login method stay).

## Email

Invites and "ready to watch" notices use Cloudflare's Email Sending. Set it up for your domain in the dashboard
(*Email* → *Email Sending*, add the DNS records it shows), then use *Send me a test email* on the admin page's Users
tab. Until then, invites show a link you can share yourself.

## By hand

`worker/wrangler.example.jsonc` lists every setting. Create the D1 database and the two Access apps (one-time PIN,
paths `/admin` and `/me` with their `/*` children; admin: allow your email; guests: allow everyone), fill in the
example, then `npx wrangler d1 migrations apply <db> --remote`, `npx wrangler deploy`, and `npx wrangler secret put`
for each secret listed at the top of the example.

## Settings you may want to change later

In `wrangler.<name>.jsonc` → `vars` (then `npx wrangler deploy --config wrangler.<name>.jsonc`):
`SERVER_NAME` (what apps show), `STORAGE_NAME`, `STORAGE_QUOTA_MB` (shared hosting plan size), `LIBRARY_ROOTS`
(folders; see [Architecture](architecture.md#folders-library-roots)), `EMAIL_FROM`.
