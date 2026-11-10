'use strict';

try {
  require('dotenv').config(); // optional: only if the dotenv package is installed
} catch (err) {
  // environment variables come from the host instead
}

// Fail at start-up, not on the first login, when a secret is missing or weak.
const problems = [];
if (!process.env.DATABASE_URL) problems.push('DATABASE_URL is not set');
for (const name of ['JWT_SECRET', 'PLATFORM_JWT_SECRET', 'ENCRYPTION_KEY']) {
  if (!process.env[name] || process.env[name].length < 32) problems.push(`${name} must be at least 32 characters`);
}
if (process.env.JWT_SECRET && process.env.JWT_SECRET === process.env.PLATFORM_JWT_SECRET) {
  problems.push('JWT_SECRET and PLATFORM_JWT_SECRET must be different');
}
if (problems.length) {
  console.error(`Cannot start:\n - ${problems.join('\n - ')}`);
  process.exit(1);
}

const app = require('./app');
const { pool } = require('./config/database');

const port = parseInt(process.env.PORT || '3000', 10);
const server = app.listen(port, () => {
  console.log(JSON.stringify({ t: new Date().toISOString(), level: 'info', msg: `Kaunta API listening on ${port}` }));
});

// Finish the requests in flight, then close the database pool.
let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(JSON.stringify({ t: new Date().toISOString(), level: 'info', msg: `${signal} received, shutting down` }));
  server.close(async () => {
    try {
      await pool.end();
    } catch (err) {
      console.error('Error closing the database pool:', err);
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 15000).unref(); // do not hang forever
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

module.exports = server;
