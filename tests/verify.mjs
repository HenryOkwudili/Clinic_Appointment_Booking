import 'dotenv/config';
import assert from 'node:assert/strict';
import pg from 'pg';

const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const apiKey = process.env.API_KEY;
if (!apiKey) throw new Error('API_KEY must be configured in the environment.');

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10000 })
  : null;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isoAfter(minutes) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

async function request(path, { method = 'GET', body, raw, contentType = 'application/json', key = apiKey, headers: extraHeaders = {} } = {}) {
  const headers = new Headers(extraHeaders);
  if (key !== null) headers.set('X-API-Key', key);
  if (contentType) headers.set('Content-Type', contentType);
  const options = { method, headers };
  if (raw !== undefined) options.body = raw;
  else if (body !== undefined) options.body = JSON.stringify(body);
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  let data = text;
  if (response.headers.get('content-type')?.includes('application/json')) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  return { response, data };
}

function evidence(label, method, path, result) {
  const body = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
  console.log(`${label}: ${method} ${path} -> ${result.response.status} ${body.slice(0, 180)}`);
}

function expectStatus(label, method, path, result, status) {
  evidence(label, method, path, result);
  assert.equal(result.response.status, status, `${label} expected HTTP ${status}`);
  assert.ok(result.response.headers.get('content-type')?.includes('application/json'), `${label} must return JSON`);
}

function expectError(label, method, path, result, status) {
  expectStatus(label, method, path, result, status);
  assert.deepEqual(Object.keys(result.data).sort(), ['error']);
  assert.equal(typeof result.data.error, 'string');
}

const slots = [
  { id: 'core', provider: 'Dr Ada', start: isoAfter(90), end: isoAfter(90.5) },
  { id: 'started', provider: 'Dr Ada', start: new Date(Date.now() - 60_000).toISOString(), end: new Date(Date.now() + 30_000).toISOString() },
  ...Array.from({ length: 3 }, (_, index) => ({ id: `parallel-${index + 1}`, provider: 'Dr Bo', start: isoAfter(91 + index), end: isoAfter(91.5 + index) })),
  { id: 'idem', provider: 'Dr Cy', start: isoAfter(92), end: isoAfter(92.5) },
  { id: 'parallel-idem', provider: 'Dr Cy', start: isoAfter(92.75), end: isoAfter(93.25) },
  { id: 'cancel', provider: 'Dr Di', start: isoAfter(93), end: isoAfter(93.5) },
  ...Array.from({ length: 7 }, (_, index) => ({ id: `limit-${index}`, provider: 'Dr Em', start: isoAfter(100 + index), end: isoAfter(100.5 + index) })),
  ...Array.from({ length: 25 }, (_, index) => ({ id: `page-${String(index).padStart(2, '0')}`, provider: 'Dr Fa', start: isoAfter(120 + index), end: isoAfter(120.5 + index) }))
];

const reset = await request('/reset', { method: 'POST', body: { slots } });
expectStatus('L1 reset', 'POST', '/reset', reset, 200);

const missingKey = await request('/slots', { key: null });
expectError('L2 missing key', 'GET', '/slots', missingKey, 401);
const wrongKey = await request('/slots', { key: 'wrong-key' });
expectError('L2 wrong key', 'GET', '/slots', wrongKey, 401);
const emptyKey = await request('/slots', { key: '' });
expectError('L2 empty key', 'GET', '/slots', emptyKey, 401);

const listed = await request('/slots');
expectStatus('L1 list slots', 'GET', '/slots', listed, 200);
assert.equal(listed.data.slots.length, slots.length);
assert.equal(listed.data.slots[0].available, true);
assert.ok(listed.data.slots.every((slot) => typeof slot.available === 'boolean'));
const filtered = await request('/slots?provider=Dr%20Ada');
expectStatus('L1 provider filter', 'GET', '/slots?provider=Dr%20Ada', filtered, 200);
assert.ok(filtered.data.slots.every((slot) => slot.provider === 'Dr Ada'));

const created = await request('/bookings', {
  method: 'POST',
  body: { slot_id: 'core', name: ' Ada Obi ', email: ' ADA@example.test ' }
});
expectStatus('L1 book', 'POST', '/bookings', created, 201);
assert.deepEqual(Object.keys(created.data).sort(), ['created_at', 'email', 'id', 'name', 'slot_id', 'status']);
assert.equal(created.data.name, 'Ada Obi');
assert.equal(created.data.email, 'ada@example.test');
assert.equal(created.data.status, 'confirmed');
assert.ok(!Number.isNaN(Date.parse(created.data.created_at)));
const bookingLookup = await request(`/bookings/${created.data.id}`);
expectStatus('L1 get booking', 'GET', `/bookings/${created.data.id}`, bookingLookup, 200);
assert.equal(bookingLookup.data.id, created.data.id);
const unknownBooking = await request('/bookings/not-a-booking');
expectError('L1 unknown booking', 'GET', '/bookings/not-a-booking', unknownBooking, 404);

for (const [label, body] of [
  ['missing slot_id', { name: 'Test Patient', email: 'missing-slot@example.test' }],
  ['missing name', { slot_id: 'core', email: 'missing-name@example.test' }],
  ['missing email', { slot_id: 'core', name: 'Test Patient' }],
  ['empty name', { slot_id: 'core', name: '  ', email: 'empty-name@example.test' }],
  ['empty email', { slot_id: 'core', name: 'Test Patient', email: ' ' }],
  ['wrong slot type', { slot_id: 3, name: 'Test Patient', email: 'wrong-slot@example.test' }],
  ['wrong name type', { slot_id: 'core', name: 7, email: 'wrong-name@example.test' }],
  ['wrong email type', { slot_id: 'core', name: 'Test Patient', email: ['a@example.test'] }],
  ['invalid email', { slot_id: 'core', name: 'Test Patient', email: 'not-an-email' }]
]) {
  const result = await request('/bookings', { method: 'POST', body });
  expectError(`L2 ${label}`, 'POST', '/bookings', result, 400);
}

const unknownSlot = await request('/bookings', {
  method: 'POST', body: { slot_id: 'missing', name: 'Test Patient', email: 'unknown-slot@example.test' }
});
expectError('L2 unknown slot', 'POST', '/bookings', unknownSlot, 404);
const startedSlot = await request('/bookings', {
  method: 'POST', body: { slot_id: 'started', name: 'Test Patient', email: 'started-slot@example.test' }
});
expectError('L2 started slot', 'POST', '/bookings', startedSlot, 400);
const malformed = await request('/bookings', { method: 'POST', raw: '{bad json' });
expectError('L2 malformed JSON', 'POST', '/bookings', malformed, 400);
const wrongContentType = await request('/bookings', {
  method: 'POST', raw: '{"slot_id":"core"}', contentType: 'text/plain'
});
expectError('L2 wrong content type', 'POST', '/bookings', wrongContentType, 400);
const oversized = await request('/bookings', {
  method: 'POST', body: { slot_id: 'core', name: 'x'.repeat(33000), email: 'large@example.test' }
});
expectError('L2 body cap', 'POST', '/bookings', oversized, 413);
const unknownRoute = await request('/missing-route');
expectError('L2 unknown route', 'GET', '/missing-route', unknownRoute, 404);
const wrongMethod = await request('/slots', { method: 'POST', body: {} });
expectError('L2 wrong method', 'POST', '/slots', wrongMethod, 405);

let raceWinner;
for (let slotIndex = 0; slotIndex < 3; slotIndex += 1) {
  const raceSlot = `parallel-${slotIndex + 1}`;
  const races = await Promise.all(Array.from({ length: 40 }, (_, index) => request('/bookings', {
    method: 'POST',
    body: { slot_id: raceSlot, name: `Race Patient ${index}`, email: `race-${slotIndex}-${index}@example.test` }
  })));
  const successes = races.filter((result) => result.response.status === 201);
  const conflicts = races.filter((result) => result.response.status === 409);
  const unexpected = races.filter((result) => ![201, 409].includes(result.response.status));
  console.log(`L3 parallel ${raceSlot}: ${successes.length} x 201, ${conflicts.length} x 409, ${unexpected.length} unexpected`);
  if (unexpected.length > 0) {
    console.log(`L3 unexpected examples: ${unexpected.slice(0, 3).map((result) => `${result.response.status} ${JSON.stringify(result.data)}`).join(' | ')}`);
  }
  assert.equal(successes.length, 1);
  assert.equal(conflicts.length, 39);
  assert.equal(unexpected.length, 0);
  if (slotIndex === 0) raceWinner = successes[0].data;
  if (pool) {
    const count = await pool.query(
      "SELECT count(*)::integer AS count FROM bookings WHERE slot_id = $1 AND status = 'confirmed'",
      [raceSlot]
    );
    assert.equal(count.rows[0].count, 1, `database must contain one active booking for ${raceSlot}`);
  }
}
if (pool) console.log('L3 database check: exactly 1 active booking per raced slot.');
const cancelled = await request(`/bookings/${raceWinner.id}`, { method: 'DELETE' });
expectStatus('L3 cancel', 'DELETE', `/bookings/${raceWinner.id}`, cancelled, 200);
assert.equal(cancelled.data.status, 'cancelled');
const republishedSlot = await request('/slots');
assert.equal(republishedSlot.data.slots.find((slot) => slot.id === 'parallel-1').available, true);
const rebooked = await request('/bookings', {
  method: 'POST', body: { slot_id: 'parallel-1', name: 'Replacement Patient', email: 'replacement@example.test' }
});
expectStatus('L3 rebook after cancel', 'POST', '/bookings', rebooked, 201);
const cancelAgain = await request(`/bookings/${raceWinner.id}`, { method: 'DELETE' });
expectError('L3 cancel twice', 'DELETE', `/bookings/${raceWinner.id}`, cancelAgain, 409);
const cancelMissing = await request('/bookings/not-a-booking', { method: 'DELETE' });
expectError('L3 cancel unknown', 'DELETE', '/bookings/not-a-booking', cancelMissing, 404);

const idemBody = { slot_id: 'idem', name: 'Idem Patient', email: 'idem@example.test' };
const idemHeaders = { 'Idempotency-Key': 'verify-idem-sequential' };
const idemFirst = await request('/bookings', { method: 'POST', body: idemBody, headers: idemHeaders });
expectStatus('L4 idempotency first', 'POST', '/bookings', idemFirst, 201);
const idemSecond = await request('/bookings', { method: 'POST', body: idemBody, headers: idemHeaders });
expectStatus('L4 idempotency replay', 'POST', '/bookings', idemSecond, 201);
assert.deepEqual(idemSecond.data, idemFirst.data);
const parallelIdemBody = { ...idemBody, slot_id: 'parallel-idem', email: 'idem-parallel@example.test' };
const parallelIdem = await Promise.all(Array.from({ length: 4 }, () => request('/bookings', {
  method: 'POST', body: parallelIdemBody, headers: { 'Idempotency-Key': 'verify-idem-parallel' }
})));
assert.ok(parallelIdem.every((result) => result.response.status === 201 && result.data.id === parallelIdem[0].data.id));
console.log(`L4 parallel idempotent retries: 4 x 201 with one booking id (${parallelIdem[0].data.id}).`);
const idemChanged = await request('/bookings', {
  method: 'POST',
  body: { ...idemBody, name: 'Different Patient' },
  headers: idemHeaders
});
expectError('L4 changed body', 'POST', '/bookings', idemChanged, 422);
if (pool) {
  const count = await pool.query("SELECT count(*)::integer AS count FROM bookings WHERE slot_id = 'idem' AND status = 'confirmed'");
  assert.equal(count.rows[0].count, 1, 'idempotency must create one active booking');
}

for (let index = 0; index < 25; index += 1) {
  if (index > 0 && index % 5 === 0) {
    console.log(`L4 pagination load: waiting 61 seconds for the per-email limit (created ${index}/25).`);
    await delay(61_000);
  }
  const result = await request('/bookings', {
    method: 'POST',
    body: { slot_id: `page-${String(index).padStart(2, '0')}`, name: 'Page Patient', email: 'pagination@example.test' }
  });
  assert.equal(result.response.status, 201, `pagination booking ${index + 1} must be accepted`);
}
console.log('L4 pagination setup: 25 bookings created for one email across five rate-limit windows.');

const allPageIds = [];
let cursor;
let pageCount = 0;
let priorOrder;
do {
  const params = new URLSearchParams({ email: 'PAGINATION@example.test', limit: '7' });
  if (cursor) params.set('cursor', cursor);
  const page = await request(`/bookings?${params}`);
  expectStatus(`L4 pagination page ${pageCount + 1}`, 'GET', `/bookings?limit=7`, page, 200);
  assert.ok(Array.isArray(page.data.bookings));
  for (const booking of page.data.bookings) {
    const order = `${booking.created_at}|${booking.id}`;
    if (priorOrder) assert.ok(order >= priorOrder, 'pagination ordering must be stable and oldest first');
    priorOrder = order;
    allPageIds.push(booking.id);
  }
  cursor = page.data.next_cursor;
  pageCount += 1;
} while (cursor !== null && pageCount < 10);
assert.equal(allPageIds.length, 25);
assert.equal(new Set(allPageIds).size, 25);
assert.ok(pageCount >= 4);
const otherPerson = await request('/bookings?email=someone-else%40example.test');
expectStatus('L4 email isolation', 'GET', '/bookings?email=someone-else%40example.test', otherPerson, 200);
assert.deepEqual(otherPerson.data.bookings, []);
for (const limit of ['0', '51', 'nope', '1.5']) {
  const invalid = await request(`/bookings?email=pagination%40example.test&limit=${limit}`);
  expectError(`L4 invalid limit ${limit}`, 'GET', '/bookings', invalid, 400);
}
const badCursor = await request('/bookings?email=pagination%40example.test&cursor=not-a-cursor');
expectError('L4 invalid cursor', 'GET', '/bookings', badCursor, 400);
console.log(`L4 pagination verified: ${allPageIds.length} unique bookings across ${pageCount} pages, no gaps.`);

const limitedEmail = 'rate-limit@example.test';
for (let index = 0; index < 5; index += 1) {
  const result = await request('/bookings', {
    method: 'POST',
    body: { slot_id: `limit-${index}`, name: 'Limit Patient', email: limitedEmail }
  });
  assert.equal(result.response.status, 201, `attempt ${index + 1} should be allowed`);
}
const sixthAttempt = await request('/bookings', {
  method: 'POST',
  body: { slot_id: 'limit-5', name: 'Limit Patient', email: limitedEmail }
});
expectError('L5 sixth attempt', 'POST', '/bookings', sixthAttempt, 429);
const retryAfter = Number(sixthAttempt.response.headers.get('Retry-After'));
assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1);
console.log(`L5 Retry-After: ${retryAfter} seconds.`);
const otherEmailTraffic = await request('/bookings', {
  method: 'POST', body: { slot_id: 'limit-6', name: 'Other Patient', email: 'unlimited@example.test' }
});
expectStatus('L5 independent email', 'POST', '/bookings', otherEmailTraffic, 201);
console.log(`L5 recovery check: waiting ${retryAfter + 1} seconds.`);
await delay((retryAfter + 1) * 1000);
const recovered = await request('/bookings', {
  method: 'POST', body: { slot_id: 'limit-5', name: 'Limit Patient', email: limitedEmail }
});
expectStatus('L5 recovered after window', 'POST', '/bookings', recovered, 201);

const finalReset = await request('/reset', { method: 'POST', body: { slots: [] } });
expectStatus('Final clean reset', 'POST', '/reset', finalReset, 200);
const emptySlots = await request('/slots');
expectStatus('Final empty slots', 'GET', '/slots', emptySlots, 200);
assert.deepEqual(emptySlots.data.slots, []);
if (pool) {
  const cleared = await pool.query(`
    SELECT (SELECT count(*) FROM bookings)::integer AS bookings,
           (SELECT count(*) FROM idempotency_records)::integer AS idempotency,
           (SELECT count(*) FROM booking_attempts)::integer AS attempts
  `);
  assert.deepEqual(cleared.rows[0], { bookings: 0, idempotency: 0, attempts: 0 });
  console.log('Final database check: bookings, idempotency records, and rate-limit attempts are all cleared.');
}

if (pool) await pool.end();
console.log(`ALL CHECKS PASSED against ${baseUrl}`);