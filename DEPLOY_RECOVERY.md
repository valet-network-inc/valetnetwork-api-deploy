# Getting the API back up without AWS

**Why:** the AWS account is locked (root login is `@valetnyc.co`, which can no
longer receive the MFA code). The EC2 box at `18.212.79.178` is unreachable and
we cannot start it. This moves the backend to Render instead.

**Nothing is lost.** The old box stored no data:

- customer / order / valet records live in **MongoDB Atlas**
- photos live in **Firebase Storage** (uploads use `memoryStorage()`, never disk)

Only the config file on that box is gone, and every value in it can be re-issued
from the service that owns it.

---

## The 8 secrets you need, and where each one comes from

Collect these before starting. Paste each into Render's **Environment** tab.

| Name | Where to get it |
|---|---|
| `MONGO_URI` | Atlas → your cluster → **Connect** → **Drivers**. If the password is unknown, Atlas → **Database Access** → edit user → **Edit Password**, then paste the new one into the string. |
| `STRIPE_API_KEY` | Stripe → **Developers → API keys** → *Secret key* (`sk_live_…`). Reveal, or **Roll** it if it will not reveal. |
| `STRIPE_WEBHOOK_SECRET` | Stripe → **Developers → Webhooks**. Point the endpoint at `https://api.valetnetwork.co/api/payment/webhook`, then copy its **Signing secret** (`whsec_…`). |
| `RESEND_API_KEY` | resend.com → **API Keys** → create a new one. |
| `ADMIN_API_KEY` | You choose this. Any long random string — it is the password the admin dashboard uses to talk to the API. It must match what the dashboard sends. |
| `REACT_APP_GOOGLE_MAPS_APIKEY` | Google Cloud Console → **APIs & Services → Credentials**. **Confirm billing is on** — this key was cut off for non-payment in July. |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Already on the Mac: `prod-profiles/valetnyc-39ecd-firebase-adminsdk-fbsvc-267e0e5731.json`. Paste the whole file as one line. |
| `YARDSTIK_*` (4 vars) | Yardstik dashboard. Only needed for valet background checks — the API runs fine without them. |

> The `firebase-admin.json` committed in this repo is the **dev** project
> (`valet-nyc-dev`). If `FIREBASE_SERVICE_ACCOUNT_JSON` is not set, the app falls
> back to it and every push notification silently goes nowhere. The startup log
> prints which project it used — check it.

---

## Steps

### 1. Push this folder to GitHub
A private repo is fine. `.env*` and `firebase-admin.json` must stay out of it —
see `.gitignore`.

### 2. Create the Render service
render.com → **New → Blueprint** → pick the repo. It reads `render.yaml` and
prompts for each secret marked `sync: false`.

Use the **Starter** plan, not Free. Free instances sleep after 15 minutes idle,
which means the first customer of the day waits ~30 seconds for a cold start.

### 3. Let MongoDB accept the new server
Atlas → **Network Access**. The old EC2 IP is allowlisted; Render's is not, so
the app will boot and sit retrying until this is done.

Either allowlist Render's static outbound IPs (Render service → **Connect →
Outbound**), or temporarily add `0.0.0.0/0` to get running and tighten after.

The log tells you when this is the problem — it prints the Atlas allowlist hint
on every retry.

### 4. Check it before sending traffic
Render gives the service a URL like `valetnetwork-api.onrender.com`:

```bash
curl -s https://valetnetwork-api.onrender.com/health
```

`{"status":"ok","db":"connected"}` means it is live. `degraded` means step 3
is not finished.

### 5. Point the domain at it
GoDaddy → DNS for **valetnetwork.co** → edit the `api` record.

Delete the `A` record pointing at `18.212.79.178`, add a `CNAME` for `api`
pointing at the Render hostname. Then add `api.valetnetwork.co` as a custom
domain in Render so it issues the TLS certificate.

Allow ~15 minutes for DNS, then:

```bash
curl -s https://api.valetnetwork.co/health
```

### 6. Deal with the order backlog
`AUTO_CANCEL_ENABLED` is `false` for the first boot on purpose.

Every order still `pending` from when the API died is now hours past the
30-minute limit. Turning this on cancels **and refunds** all of them within a
minute. That is probably the right outcome — nobody serviced those cars — but
look at the list in the dashboard first, then set it to `true` and redeploy.

---

## Still broken after this, and not fixed by the move

1. **Email.** `valetnetwork.co` is not a verified sending domain at Resend — I
   checked the DNS and there are no Resend records on it. Receipts and
   confirmations will not send until you verify it at resend.com/domains and add
   the records to GoDaddy.
2. **Background checks.** The Yardstik webhook is registered at
   `https://api.valetnyc.co/...` inside the Yardstik dashboard. Results can never
   arrive. Repoint it to `api.valetnetwork.co` there — it is not in this code.
3. **Google Maps billing.** Verify it is on. A dead Maps key blanks the valet
   order feed, which looks exactly like "the valet cannot see the order".
4. **AWS.** Still worth recovering later — it holds the billing meter and any
   snapshots. AWS Support can verify identity by payment card and phone without
   email: https://support.aws.amazon.com/#/contacts/aws-account-support

---

## Code changes made for this move

| File | Change |
|---|---|
| `db.js` | Retries with backoff instead of `process.exit(1)`. A blocked IP used to kill the process on boot and read as a crash loop. |
| `server.js` | `EADDRINUSE` is now fatal. It used to fall back to a **random port**, leaving a "healthy" service that 502'd on every request. |
| `server.js` | Added `GET /health` reporting DB state. There was no health endpoint. |
| `server.js` | Firebase credential read from `FIREBASE_SERVICE_ACCOUNT_JSON`, falling back to the bundled dev key with a loud warning. |
| `server.js` | socket.io CORS now includes production origins. The old list was `['*', …dev hosts]` — `'*'` in an array is matched as a literal origin, not a wildcard, so no production browser could open a live socket. |
| `server.js` | Swagger loading wrapped in try/catch. A missing yaml used to crash before `listen()`. |
| `server.js` | Auto-cancel job gated behind `AUTO_CANCEL_ENABLED`. |
| `providerNotifyService.js` | Sender default → `noreply@valetnetwork.co`. |
| `payoutController.js` | Payout alerts → `developer@valetnetwork.co`. |
| `certnProvider.js` | Webhook fallback → `api.valetnetwork.co`. |
| `paymentController.js` | Payment-success fallback → `valetnetwork.co` (was `valetnyc.com`). |
| `streetSegmentResolver.js` | Overpass User-Agent contact → `ops@valetnetwork.co`. |
