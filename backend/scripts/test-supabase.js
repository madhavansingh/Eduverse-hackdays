const { Pool } = require('pg');
require('dotenv').config();

async function testSupabase() {
  console.log('Testing Supabase PostgreSQL connection...');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const client = await pool.connect();
    console.log('Successfully connected to Supabase PostgreSQL!');

    const res = await client.query('SELECT current_database(), current_user, version()');
    console.log('Database Info:', res.rows[0]);

    const tablesRes = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);
    console.log(`Found ${tablesRes.rows.length} existing tables in Supabase public schema:`);
    tablesRes.rows.forEach((r) => console.log(' -', r.table_name));

    client.release();
    await pool.end();
  } catch (err) {
    console.error('Connection failed:', err.message);
    process.exit(1);
  }
}

testSupabase();
