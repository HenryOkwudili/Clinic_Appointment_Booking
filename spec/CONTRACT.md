# API Contract Checklist

Source of truth: [`openapi.json`](./openapi.json), OpenAPI 3.0.3.

## Global

- [ ] JSON request/response behavior; errors are exactly `{ "error": "<message>" }`.
- [ ] Every API request requires `X-API-Key`; missing, wrong, or empty key returns 401.
- [ ] API key comparison is constant-time. CORS supports `X-API-Key`, `Idempotency-Key`, and OPTIONS.

## Endpoints

- [ ] `POST /reset` (L1): JSON `{ "slots": Slot[] }`; each slot requires string `id`, string `provider`, and date-time strings `start`, `end`. Replace slots and clear bookings. Response 200.
- [ ] `GET /slots` (L1): optional exact-match string `provider`; response 200 `{ "slots": SlotWithAvailability[] }`, earliest `start` first. Each slot contains `id`, `provider`, `start`, `end`, boolean `available`.
- [ ] `POST /bookings` (L1-L5): JSON requires string `slot_id`, `name`, `email`. Trim `name` and `email`, lowercase stored email. Missing/empty/invalid email or already-started slot: 400. Unknown slot: 404. Success: 201 `Booking` with `id`, `slot_id`, `name`, `email`, `status: "confirmed"`, `created_at`.
  - [ ] Already-confirmed slot: 409; enforce atomically in PostgreSQL.
  - [ ] Optional `Idempotency-Key`: same key and body replays the original status and response; same key with a different body: 422.
  - [ ] At most 5 attempts per email per 60 seconds, including failed attempts; 6th: 429 with integer-seconds `Retry-After`. Other emails are independent.
- [ ] `GET /bookings` (L4): required `email`; case-insensitive match; oldest first. Optional `limit` defaults to 10 and must be integer 1-50. Optional `cursor` is the prior page's `next_cursor`. Response 200 `{ "bookings": Booking[], "next_cursor": string | null }`; final page has null cursor. Invalid limit: 400.
- [ ] `GET /bookings/{id}` (L1): response 200 `Booking`; missing ID: 404.
- [ ] `DELETE /bookings/{id}` (L3): response 200 cancelled `Booking`; missing ID: 404; already cancelled: 409. Cancellation frees the slot.

## Error and transport checks

- [ ] Invalid JSON, unsupported content type, unknown routes, and wrong methods return JSON errors, never HTML or 500.
- [ ] No response leaks bookings belonging to another email.

## Contract gaps recorded

- The OpenAPI document does not define response bodies for successful reset, exact error messages, validation length limits, cursor encoding, or statuses for malformed transport/query input beyond invalid `limit`. Use small consistent JSON errors; return 400 for malformed/invalid inputs and 404/405 for routing errors. Do not invent booking field length limits absent from the source contract.
- OpenAPI does not specify whether cancelled bookings appear in a person's booking list. Preserve them as booking records and include them in the person's history, ordered by `created_at` then `id`.