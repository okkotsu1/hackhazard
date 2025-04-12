// db.js
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.PGHOST,
  port:     +process.env.PGPORT,
  database: process.env.PGDATABASE,
  user:     process.env.PGUSER,
  password: process.env.PGPASSWORD,
  max:      10,
  idleTimeoutMillis: 30000
});

pool.on('error', err => {
  console.error('Unexpected Postgres error', err);
  process.exit(-1);
});

module.exports = pool;