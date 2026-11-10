import 'dotenv/config';
import app from './app.js';
import { ensureSchema, pool } from './db.js';

const port = Number(process.env.PORT || 3000);

await ensureSchema();
const server = app.listen(port, () => console.log(`Clinic booking API listening on ${port}`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  });
}