import { Pool } from 'pg';

const pool = globalThis.__clinicBookingPool ?? new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 60000
});

globalThis.__clinicBookingPool = pool;

let schemaPromise;

async function schemaIsReady(client) {
  const result = await client.query(`
    SELECT to_regclass('public.slots') IS NOT NULL
       AND to_regclass('public.bookings') IS NOT NULL
       AND to_regclass('public.bookings_one_active_per_slot') IS NOT NULL
       AND to_regclass('public.idempotency_records') IS NOT NULL
       AND to_regclass('public.booking_attempts') IS NOT NULL AS ready
  `);
  return result.rows[0].ready;
}

export async function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      if (await schemaIsReady(pool)) return;
      await withTransaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('clinic-booking-schema', 0))");
        if (await schemaIsReady(client)) return;
        await client.query(`
      CREATE TABLE IF NOT EXISTS slots (
        id text PRIMARY KEY,
        provider text NOT NULL,
        start_at timestamptz NOT NULL,
        end_at timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bookings (
        id text PRIMARY KEY,
        slot_id text NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
        name text NOT NULL,
        email text NOT NULL,
        status text NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_active_per_slot
        ON bookings(slot_id) WHERE status = 'confirmed';
      CREATE INDEX IF NOT EXISTS bookings_email_order
        ON bookings(email, created_at, id);
      CREATE TABLE IF NOT EXISTS idempotency_records (
        idempotency_key text PRIMARY KEY,
        request_hash text NOT NULL,
        response_status integer NOT NULL,
        response_body jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE TABLE IF NOT EXISTS booking_attempts (
        id bigserial PRIMARY KEY,
        email text NOT NULL,
        attempted_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE INDEX IF NOT EXISTS booking_attempts_email_time
        ON booking_attempts(email, attempted_at);
        `);
      });
    })().catch((error) => {
      schemaPromise = undefined;
      throw error;
    });
  }
  await schemaPromise;
}

export async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export { pool };