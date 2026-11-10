import { createHash, randomUUID } from 'node:crypto';
import { withTransaction } from './db.js';
import { isRecord, validateBooking } from './validation.js';

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function jsonResponse(status, body, headers = {}) {
  return { status, body, headers };
}

async function saveIdempotentResponse(client, key, requestHash, response) {
  if (key) {
    await client.query(
      `INSERT INTO idempotency_records
         (idempotency_key, request_hash, response_status, response_body)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [key, requestHash, response.status, JSON.stringify(response.body)]
    );
  }
  return response;
}

export async function createBooking(body, rawIdempotencyKey) {
  const key = typeof rawIdempotencyKey === 'string' && rawIdempotencyKey.length > 0
    ? rawIdempotencyKey
    : null;
  const requestHash = createHash('sha256').update(stableJson(body)).digest('hex');
  const email = isRecord(body) && typeof body.email === 'string' && body.email.trim()
    ? body.email.trim().toLowerCase()
    : null;

  return withTransaction(async (client) => {
    let retryAfter = null;
    if (email) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`rate:${email}`]);
      await client.query(
        "DELETE FROM booking_attempts WHERE email = $1 AND attempted_at < clock_timestamp() - interval '60 seconds'",
        [email]
      );
      await client.query('INSERT INTO booking_attempts(email) VALUES ($1)', [email]);
      const attempts = await client.query(
        `SELECT count(*)::integer AS count,
                ceil(greatest(1, extract(epoch FROM (min(attempted_at) + interval '60 seconds' - clock_timestamp()))))::integer AS retry_after
         FROM booking_attempts WHERE email = $1`,
        [email]
      );
      if (attempts.rows[0].count > 5) retryAfter = attempts.rows[0].retry_after;
    }

    if (key) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`idempotency:${key}`]);
      const prior = await client.query(
        'SELECT request_hash, response_status, response_body FROM idempotency_records WHERE idempotency_key = $1',
        [key]
      );
      if (prior.rowCount > 0) {
        const record = prior.rows[0];
        if (record.request_hash !== requestHash) {
          return jsonResponse(422, { error: 'Idempotency-Key was already used with a different body' });
        }
        return jsonResponse(record.response_status, record.response_body);
      }
    }

    const validated = validateBooking(body);
    if (retryAfter !== null) {
      return jsonResponse(429, { error: 'Too many booking attempts for this email' }, { 'Retry-After': String(retryAfter) });
    }
    if (validated.error) {
      return saveIdempotentResponse(client, key, requestHash, jsonResponse(400, { error: validated.error }));
    }

    const slot = await client.query(
      'SELECT id, start_at <= clock_timestamp() AS started FROM slots WHERE id = $1',
      [validated.value.slot_id]
    );
    if (slot.rowCount === 0) {
      return saveIdempotentResponse(client, key, requestHash, jsonResponse(404, { error: 'slot not found' }));
    }
    if (slot.rows[0].started) {
      return saveIdempotentResponse(client, key, requestHash, jsonResponse(400, { error: 'slot has already started' }));
    }

    const booking = {
      id: randomUUID(),
      slot_id: validated.value.slot_id,
      name: validated.value.name,
      email: validated.value.email,
      status: 'confirmed'
    };
    const inserted = await client.query(
      `INSERT INTO bookings(id, slot_id, name, email, status)
       VALUES ($1, $2, $3, $4, 'confirmed')
       ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
       RETURNING id, slot_id, name, email, status, created_at`,
      [booking.id, booking.slot_id, booking.name, booking.email]
    );
    if (inserted.rowCount === 0) {
      return saveIdempotentResponse(client, key, requestHash, jsonResponse(409, { error: 'slot is already booked' }));
    }
    return saveIdempotentResponse(client, key, requestHash, jsonResponse(201, inserted.rows[0]));
  });
}