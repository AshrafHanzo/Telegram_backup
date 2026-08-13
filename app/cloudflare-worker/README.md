# Telegram Drive — Always-On Temp Link Relay

Makes Temp Links keep working even when your desktop app isn't running / your
PC is off, using a free Cloudflare Worker + a Telegram Bot instead of your
own machine as the server. See `src/worker.js` for how it works and its
limits (20MB file size cap — a Telegram Bot API restriction, not ours).

## One-time setup

### 1. Create a Telegram Bot
1. Open Telegram, message **@BotFather**.
2. Send `/newbot`, follow the prompts (pick any name/username).
3. Copy the **bot token** it gives you (looks like `123456789:AAH...`).
4. Paste it into the desktop app: **Settings → Sharing → Always-on links → Bot Token**.
   The app will automatically add this bot as an admin to any folder you
   create an always-on link for, plus a hidden "relay" channel it manages.

### 2. Create a free Cloudflare account
Sign up at https://dash.cloudflare.com/sign-up — no credit card needed for
Workers' free tier.

### 3. Install Wrangler and log in
```bash
cd cloudflare-worker
npm install
npx wrangler login
```

### 4. Create the KV namespace
```bash
npx wrangler kv namespace create SHARES
```
It prints an `id`. Paste it into `wrangler.toml`, replacing
`REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

### 5. Set the two secrets
```bash
npx wrangler secret put AUTH_SECRET
# paste any long random string when prompted

npx wrangler secret put ADMIN_SECRET
# paste any long random string when prompted — then paste the SAME value
# into the desktop app's Settings → Sharing → Always-on links → Admin Secret
```

### 6. Deploy
```bash
npx wrangler deploy
```
It prints your Worker's URL, e.g. `https://telegram-drive-relay.<you>.workers.dev`.
Paste that into the desktop app's Settings → Sharing → Always-on links → Relay URL.

That's it — from then on, checking "Always-on (works when your PC is off)"
when creating a Temp Link routes it through this Worker instead of your
local machine.

## Limits to know about
- **20MB max file size** — a hard Telegram Bot API restriction on `getFile`,
  not something this Worker can raise. Bigger files only work through the
  desktop app's own tunnel (which uses your full account, no such cap).
- **Download only** — upload/update/delete-permissioned links still need the
  desktop app + tunnel running; the always-on relay only serves downloads.
- Cloudflare's free tier: 100,000 requests/day and generous KV limits — far
  more than a personal Temp Link feature would ever use.
