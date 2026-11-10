# Clinic Booking API

Node.js, Express, and PostgreSQL API deployed as Vercel serverless functions, with a dependency-free patient booking page at `/`. The API contract is recorded in [`spec/CONTRACT.md`](spec/CONTRACT.md); the original OpenAPI document is [`spec/openapi.json`](spec/openapi.json).

## Local setup

1. Use Node.js 22 or newer and a Neon PostgreSQL database.
2. Create `.env` from `.env.example`. Set `DATABASE_URL` to Neon's pooled connection string and `API_KEY` to a random secret. `.env` is ignored by Git.
3. Run `npm ci` and then `npm start`. The idempotent PostgreSQL migration runs on startup and on serverless cold starts.
4. Open `http://localhost:3000/`, enter the API key, then select and book a slot. The browser stores the key in `sessionStorage` for the current tab only.

Generate a key in PowerShell with:

```powershell
openssl rand -hex 32
```

## Verification

With the API running, run `npm test`. The suite sends real HTTP requests, verifies response shapes and status codes, runs three concurrent same-slot races with 40 requests each, exercises cancellation and idempotency, creates 25 bookings across the required rate-limit windows to verify cursor pagination, tests 429 recovery, checks PostgreSQL state, and finishes with an empty reset. It takes several minutes because it observes the contract's one-minute limiter window rather than bypassing it.

To run it against a deployed service:

```powershell
$env:BASE_URL = 'https://your-deployment.vercel.app'
npm test
```

The test suite requires `API_KEY`; it also checks direct PostgreSQL state when `DATABASE_URL` is available. It resets the target database and finishes with no slots, bookings, idempotency records, or rate-limit attempts. Do not point it at unrelated or production data.

## Vercel deployment

1. Run `npx vercel login` and complete the browser sign-in.
2. Link this directory with `npx vercel link`.
3. Add `API_KEY` and `DATABASE_URL` to the Vercel **Production** environment. Keep both values out of source control.
4. Deploy once with `npx vercel --prod`, then set `BASE_URL` and run the complete verification suite against the returned HTTPS URL.

The rewrite in `vercel.json` sends root-level paths to the API handler while the handler serves the static page and assets. The browser never contains a baked-in API key. The key field is user-entered and tab-scoped; anyone who has the shared key can call the API, as required by the assessment's single-key contract.

## Contract decisions

- The OpenAPI schema does not define successful reset JSON, exact error messages, string length limits, or cursor encoding. Reset returns `{ "ok": true }`; errors use the required one-field JSON envelope; cursor values are opaque base64url tuples; no arbitrary booking-field length limits are imposed (the request body is capped at 32 KB).
- Cancelled bookings remain in the patient's history. Ordering is stable by `created_at`, then `id`.
- OPTIONS requests are answered without API-key authentication so browser CORS preflight can succeed; every actual API endpoint request requires `X-API-Key`.
- Reset clears bookings, slots, idempotency responses, and rate-limit attempts in one transaction.

## Hosting note

Neon free-tier compute may suspend while idle, adding cold-start latency to the first database request. Data remains in PostgreSQL. Vercel serverless deployments reuse a small connection pool per warm instance; state never depends on process memory.