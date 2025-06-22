const { Pool } = require("pg");

const pool = new Pool({
  user: "avnadmin",
  host: process.env.DATABASE_HOST,
  database: "defaultdb",
  password: process.env.DATABASE_PASS,
  port: 15368,
  ssl: { rejectUnauthorized: false },
});

pool.connect()
  .then(() => console.log("Connected to PostgreSQL database"))
  .catch((err) => console.error("PostgreSQL connection error", err));

module.exports = pool;
