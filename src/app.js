import { timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { ensureSchema, pool, withTransaction } from './db.js';
import { createBooking } from './booking-service.js';
import { decodeCursor, encodeCursor, parseLimit, validateSlots } from './validation.js';

const app = express();
const publicDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Idempotency-Key');
  res.setHeader('Access-Control-Expose-Headers', 'Retry-After');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(express.static(publicDirectory, { index: 'index.html', fallthrough: true }));

function validApiKey(candidate) {
  const expected = Buffer.from(process.env.API_KEY ?? '', 'utf8');
  if (expected.length === 0 || typeof candidate !== 'string') return false;
  const provided = Buffer.from(candidate, 'utf8');
  const comparable = Buffer.alloc(expected.length);
  provided.copy(comparable, 0, 0, expected.length);
  const equal = timingSafeEqual(expected, comparable);
  return equal && provided.length === expected.length;
}

app.use((req, res, next) => {
  if (!validApiKey(req.get('X-API-Key'))) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

app.use(express.json({ limit: '32kb', strict: true }));

function requireJson(req, res, next) {
  if (!req.is('application/json')) return res.status(400).json({ error: 'Content-Type must be application/json' });
  next();
}

app.get('/slots', async (req, res, next) => {
  try {
    await ensureSchema();
    if (req.query.provider !== undefined && typeof req.query.provider !== 'string') {
      return res.status(400).json({ error: 'provider must be a string' });
    }
    const values = [];
    let providerClause = '';
    if (req.query.provider !== undefined) {
      values.push(req.query.provider);
      providerClause = 'WHERE s.provider = $1';
    }
    const result = await pool.query(
      `SELECT s.id, s.provider, s.start_at AS start, s.end_at AS end,
              (b.id IS NULL) AS available
       FROM slots s
       LEFT JOIN bookings b ON b.slot_id = s.id AND b.status = 'confirmed'
       ${providerClause}
       ORDER BY s.start_at ASC, s.id ASC`,
      values
    );
    res.json({ slots: result.rows });
  } catch (error) {
    next(error);
  }
});

app.post('/reset', requireJson, async (req, res, next) => {
  try {
    await ensureSchema();
    const error = validateSlots(req.body);
    if (error) return res.status(400).json({ error });
    await withTransaction(async (client) => {
      await client.query('DELETE FROM bookings');
      await client.query('DELETE FROM slots');
      await client.query('DELETE FROM idempotency_records');
      await client.query('DELETE FROM booking_attempts');
      for (const slot of req.body.slots) {
        await client.query(
          'INSERT INTO slots(id, provider, start_at, end_at) VALUES ($1, $2, $3, $4)',
          [slot.id, slot.provider, slot.start, slot.end]
        );
      }
    });
    res.status(200).json({ ok: true });
  } catch (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'slot ids must be unique' });
    next(error);
  }
});

app.post('/bookings', requireJson, async (req, res, next) => {
  try {
    await ensureSchema();
    const result = await createBooking(req.body, req.get('Idempotency-Key'));
    for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
    res.status(result.status).json(result.body);
  } catch (error) {
    next(error);
  }
});

app.get('/bookings', async (req, res, next) => {
  try {
    await ensureSchema();
    const email = req.query.email;
    if (typeof email !== 'string' || email.trim() === '') return res.status(400).json({ error: 'email is required' });
    const limit = parseLimit(req.query.limit);
    if (limit === null) return res.status(400).json({ error: 'limit must be an integer from 1 to 50' });
    const cursor = decodeCursor(req.query.cursor);
    if (cursor === undefined) return res.status(400).json({ error: 'cursor is invalid' });

    const normalizedEmail = email.trim().toLowerCase();
    const result = cursor
      ? await pool.query(
        `SELECT id, slot_id, name, email, status, created_at,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
         FROM bookings
         WHERE email = $1 AND (created_at, id) > ($2::timestamptz, $3::text)
         ORDER BY created_at ASC, id ASC LIMIT $4`,
        [normalizedEmail, cursor[0], cursor[1], limit + 1]
      )
      : await pool.query(
        `SELECT id, slot_id, name, email, status, created_at,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
         FROM bookings WHERE email = $1
         ORDER BY created_at ASC, id ASC LIMIT $2`,
        [normalizedEmail, limit + 1]
      );
    const hasMore = result.rows.length > limit;
    const pageRows = result.rows.slice(0, limit);
    const next_cursor = hasMore ? encodeCursor(pageRows[pageRows.length - 1]) : null;
    const bookings = pageRows.map(({ cursor_created_at, ...booking }) => booking);
    res.json({ bookings, next_cursor });
  } catch (error) {
    next(error);
  }
});

app.get('/bookings/:id', async (req, res, next) => {
  try {
    await ensureSchema();
    const result = await pool.query(
      'SELECT id, slot_id, name, email, status, created_at FROM bookings WHERE id = $1',
      [req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'booking not found' });
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

app.delete('/bookings/:id', async (req, res, next) => {
  try {
    await ensureSchema();
    const result = await withTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE bookings SET status = 'cancelled'
         WHERE id = $1 AND status = 'confirmed'
         RETURNING id, slot_id, name, email, status, created_at`,
        [req.params.id]
      );
      if (updated.rowCount > 0) return { status: 200, booking: updated.rows[0] };
      const existing = await client.query(
        'SELECT status FROM bookings WHERE id = $1',
        [req.params.id]
      );
      return existing.rowCount === 0
        ? { status: 404 }
        : { status: 409 };
    });
    if (result.status === 404) return res.status(404).json({ error: 'booking not found' });
    if (result.status === 409) return res.status(409).json({ error: 'booking is already cancelled' });
    res.json(result.booking);
  } catch (error) {
    next(error);
  }
});

app.all('/reset', (req, res) => res.setHeader('Allow', 'POST').status(405).json({ error: 'Method not allowed' }));
app.all('/slots', (req, res) => res.setHeader('Allow', 'GET').status(405).json({ error: 'Method not allowed' }));
app.all('/bookings', (req, res) => res.setHeader('Allow', 'GET, POST').status(405).json({ error: 'Method not allowed' }));
app.all('/bookings/:id', (req, res) => res.setHeader('Allow', 'GET, DELETE').status(405).json({ error: 'Method not allowed' }));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON' });
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large' });
  console.error('Request failed:', error.code || error.name || 'Error', error.message || '', error.detail || '');
  res.status(500).json({ error: 'Internal server error' });
});

export default app;