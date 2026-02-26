const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const isProduction = process.env.NODE_ENV === 'production';
const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);

const localPgConfig = {
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'dbpass',
  host: process.env.PGHOST || 'localhost',
  port: process.env.PGPORT || '5432',
  database: process.env.PGDATABASE || 'postgres'
};

const fallbackDatabaseUrl = `postgresql://${encodeURIComponent(localPgConfig.user)}:${encodeURIComponent(localPgConfig.password)}@${localPgConfig.host}:${localPgConfig.port}/${localPgConfig.database}`;
const connectionString = process.env.DATABASE_URL || fallbackDatabaseUrl;

console.log('DATABASE_URL:', hasDatabaseUrl ? 'Set' : `NOT SET (using local fallback: ${localPgConfig.host}:${localPgConfig.port}/${localPgConfig.database})`);

const pool = new Pool({
  connectionString,
  ssl: hasDatabaseUrl && isProduction ? { rejectUnauthorized: false } : false
});

// Initialize database tables
async function initDb() {
  if (!hasDatabaseUrl && isProduction) {
    throw new Error('DATABASE_URL environment variable is not set. Please add PostgreSQL plugin in Railway.');
  }
  
  const client = await pool.connect();
  
  try {
    // Create clients table
    await client.query(`
      CREATE TABLE IF NOT EXISTS clients (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        phone TEXT,
        email TEXT,
        instagram TEXT,
        instagram_user_id TEXT,
        whatsapp INTEGER DEFAULT 0,
        instagram_active INTEGER DEFAULT 0,
        conversation_status TEXT DEFAULT 'nuevo',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Create products table
    await client.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        category TEXT,
        size TEXT,
        color TEXT,
        price REAL NOT NULL,
        cost REAL DEFAULT 0,
        stock INTEGER DEFAULT 0,
        min_stock INTEGER DEFAULT 5,
        image_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Create messages table
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        client_id INTEGER NOT NULL,
        platform TEXT NOT NULL,
        message_text TEXT NOT NULL,
        direction TEXT NOT NULL,
        status TEXT DEFAULT 'sent',
        message_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (client_id) REFERENCES clients(id)
      )
    `);
    
    // Create sales table
    await client.query(`
      CREATE TABLE IF NOT EXISTS sales (
        id SERIAL PRIMARY KEY,
        client_id INTEGER,
        total REAL NOT NULL,
        status TEXT DEFAULT 'pending',
        payment_method TEXT,
        payment_status TEXT DEFAULT 'pending',
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (client_id) REFERENCES clients(id)
      )
    `);
    
    // Create sale_items table
    await client.query(`
      CREATE TABLE IF NOT EXISTS sale_items (
        id SERIAL PRIMARY KEY,
        sale_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        quantity INTEGER NOT NULL,
        unit_price REAL NOT NULL,
        subtotal REAL NOT NULL,
        FOREIGN KEY (sale_id) REFERENCES sales(id),
        FOREIGN KEY (product_id) REFERENCES products(id)
      )
    `);
    
    // Create payments table
    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        sale_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        payment_method TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        transaction_id TEXT,
        payment_date TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (sale_id) REFERENCES sales(id)
      )
    `);
    
    // Create users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Lightweight migrations for existing databases
    await client.query('ALTER TABLE clients ADD COLUMN IF NOT EXISTS instagram_user_id TEXT');
    await client.query('CREATE INDEX IF NOT EXISTS idx_clients_instagram_user_id ON clients(instagram_user_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id)');
    
    console.log('Database tables created successfully');
    
    // Create default admin user if none exists
    console.log('Checking for existing users...');
    const users = await pool.query('SELECT id FROM users LIMIT 1');
    console.log('Users found:', users.rows.length);
    if (users.rows.length === 0) {
      console.log('Creating default admin user...');
      const defaultPassword = await bcrypt.hash('admin123', 10);
      await pool.query(
        'INSERT INTO users (username, password, role) VALUES ($1, $2, $3)',
        ['admin', defaultPassword, 'admin']
      );
      console.log('Default admin user created: admin / admin123');
    } else {
      console.log('Users already exist, skipping default user creation');
    }
  } finally {
    client.release();
  }
}

// Helper functions using pg Pool
async function runQuery(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

async function runInsert(sql, params = []) {
  const result = await pool.query(sql, params);
  return { lastInsertRowid: result.rows[0]?.id || 0 };
}

async function runUpdate(sql, params = []) {
  const result = await pool.query(sql, params);
  return { changes: result.rowCount || 0 };
}

async function runDelete(sql, params = []) {
  const result = await pool.query(sql, params);
  return { changes: result.rowCount || 0 };
}

module.exports = {
  initDb,
  runQuery,
  runInsert,
  runUpdate,
  runDelete,
  pool
};
