const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

// Encryption key for sensitive data (should be in environment variables)
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const IV_LENGTH = 16;

// Helper to encrypt sensitive data
function encrypt(text) {
  if (!text) return null;
  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY.slice(0, 32), 'utf8'), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  } catch (error) {
    console.error('Encryption error:', error.message);
    return null;
  }
}

// Helper to decrypt sensitive data
function decrypt(text) {
  if (!text) return null;
  try {
    const parts = text.split(':');
    if (parts.length !== 2) return text; // Return as-is if not encrypted format
    const iv = Buffer.from(parts[0], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY.slice(0, 32), 'utf8'), iv);
    let decrypted = decipher.update(parts[1], 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    console.error('Decryption error:', error.message);
    return text;
  }
}

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
    // Create super_admins table
    await client.query(`
      CREATE TABLE IF NOT EXISTS super_admins (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'super_admin',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP
      )
    `);
    
    // Create tenants table
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id SERIAL PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        owner_name TEXT NOT NULL,
        owner_email TEXT UNIQUE NOT NULL,
        owner_phone TEXT,
        password TEXT NOT NULL,
        domain TEXT,
        logo_url TEXT,
        status TEXT DEFAULT 'pending',
        plan TEXT DEFAULT 'free',
        message_limit_monthly INTEGER DEFAULT 0,
        messages_sent_monthly INTEGER DEFAULT 0,
        messages_sent_today INTEGER DEFAULT 0,
        last_message_reset DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        approved_at TIMESTAMP,
        approved_by INTEGER REFERENCES super_admins(id),
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Create tenant_configs table
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenant_configs (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
        
        -- WhatsApp Business API (propio del cliente)
        whatsapp_token TEXT,
        whatsapp_phone_id TEXT,
        whatsapp_business_account_id TEXT,
        whatsapp_webhook_verify_token TEXT,
        whatsapp_enabled BOOLEAN DEFAULT FALSE,
        
        -- Instagram Business API (propio del cliente)
        instagram_access_token TEXT,
        instagram_business_account_id TEXT,
        instagram_webhook_verify_token TEXT,
        instagram_enabled BOOLEAN DEFAULT FALSE,
        
        -- Meta Graph API Version
        meta_graph_version TEXT DEFAULT 'v21.0',
        
        -- Configuración de costos
        max_messages_per_day INTEGER DEFAULT 100,
        max_messages_per_month INTEGER DEFAULT 1000,
        allow_marketing_messages BOOLEAN DEFAULT FALSE,
        cost_alert_threshold INTEGER DEFAULT 80,
        
        -- Configuración de 24hs
        response_window_hours INTEGER DEFAULT 24,
        allow_initiate_conversation BOOLEAN DEFAULT FALSE,
        
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Create tenant_audit_logs table
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenant_audit_logs (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER REFERENCES tenants(id),
        action TEXT NOT NULL,
        details JSONB,
        ip_address TEXT,
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Create clients table with tenant_id
    await client.query(`
      CREATE TABLE IF NOT EXISTS clients (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        phone TEXT,
        email TEXT,
        instagram TEXT,
        instagram_user_id TEXT,
        whatsapp INTEGER DEFAULT 0,
        instagram_active INTEGER DEFAULT 0,
        conversation_status TEXT DEFAULT 'nuevo',
        presupuesto_enviado BOOLEAN DEFAULT FALSE,
        pago_realizado BOOLEAN DEFAULT FALSE,
        envio_realizado BOOLEAN DEFAULT FALSE,
        last_message_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add new columns to existing clients table if they don't exist
    try {
      await client.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS presupuesto_enviado BOOLEAN DEFAULT FALSE`);
      await client.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS pago_realizado BOOLEAN DEFAULT FALSE`);
      await client.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS envio_realizado BOOLEAN DEFAULT FALSE`);
    } catch (e) {
      // Columns might already exist, ignore error
    }
    
    // Create products table with tenant_id
    await client.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
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
    
    // Create messages table with tenant_id
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
        client_id INTEGER NOT NULL,
        platform TEXT NOT NULL,
        message_text TEXT NOT NULL,
        direction TEXT NOT NULL,
        status TEXT DEFAULT 'sent',
        message_id TEXT,
        message_type TEXT DEFAULT 'service',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (client_id) REFERENCES clients(id)
      )
    `);
    
    // Create sales table with tenant_id
    await client.query(`
      CREATE TABLE IF NOT EXISTS sales (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
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
    
    // Create users table with tenant_id
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
        username TEXT NOT NULL,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Create indexes for better performance (wrap in try-catch for existing databases)
    const createIndexSafe = async (sql) => {
      try {
        await client.query(sql);
      } catch (e) {
        // Index might already exist or column not found - skip
      }
    };
    
    await createIndexSafe('CREATE INDEX IF NOT EXISTS idx_clients_tenant_id ON clients(tenant_id)');
    await createIndexSafe('CREATE INDEX IF NOT EXISTS idx_products_tenant_id ON products(tenant_id)');
    await createIndexSafe('CREATE INDEX IF NOT EXISTS idx_messages_tenant_id ON messages(tenant_id)');
    await createIndexSafe('CREATE INDEX IF NOT EXISTS idx_sales_tenant_id ON sales(tenant_id)');
    await createIndexSafe('CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON users(tenant_id)');
    await createIndexSafe('CREATE INDEX IF NOT EXISTS idx_clients_instagram_user_id ON clients(instagram_user_id)');
    await createIndexSafe('CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id)');
    await createIndexSafe('CREATE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug)');
    await createIndexSafe('CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status)');
    await createIndexSafe('CREATE INDEX IF NOT EXISTS idx_messages_client_last ON messages(client_id, created_at DESC)');
    
    console.log('Database tables/indices ready');
    
    console.log('Database tables created successfully');
    
    // Migrations: Add tenant_id to existing tables if they don't have it
    console.log('Running migrations...');
    
    // Add tenant_id to clients if not exists
    try {
      await client.query('ALTER TABLE clients ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE');
      console.log('Migration: Added tenant_id to clients');
    } catch (e) {
      // Column might already exist or table references don't work yet
      console.log('Migration note for clients:', e.message.split('\n')[0]);
    }
    
    // Add tenant_id to products if not exists
    try {
      await client.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE');
      console.log('Migration: Added tenant_id to products');
    } catch (e) {
      console.log('Migration note for products:', e.message.split('\n')[0]);
    }
    
    // Add tenant_id to messages if not exists
    try {
      await client.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE');
      console.log('Migration: Added tenant_id to messages');
    } catch (e) {
      console.log('Migration note for messages:', e.message.split('\n')[0]);
    }
    
    // Add tenant_id to sales if not exists
    try {
      await client.query('ALTER TABLE sales ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE');
      console.log('Migration: Added tenant_id to sales');
    } catch (e) {
      console.log('Migration note for sales:', e.message.split('\n')[0]);
    }
    
    // Add tenant_id to users if not exists
    try {
      await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE');
      console.log('Migration: Added tenant_id to users');
    } catch (e) {
      console.log('Migration note for users:', e.message.split('\n')[0]);
    }
    
    // Add last_message_at to clients if not exists
    try {
      await client.query('ALTER TABLE clients ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMP');
      console.log('Migration: Added last_message_at to clients');
    } catch (e) {
      console.log('Migration note for last_message_at:', e.message.split('\n')[0]);
    }
    
    // Add message_type to messages if not exists
    try {
      await client.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_type TEXT DEFAULT \'service\'');
      console.log('Migration: Added message_type to messages');
    } catch (e) {
      console.log('Migration note for message_type:', e.message.split('\n')[0]);
    }
    
    // Add message expiration timestamp if not exists
    try {
      await client.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_expiration TIMESTAMP');
      console.log('Migration: Added message_expiration to messages');
    } catch (e) {
      console.log('Migration note for message_expiration:', e.message.split('\n')[0]);
    }
    
    // Add service_message_allowed field if not exists
    try {
      await client.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS service_message_allowed BOOLEAN DEFAULT TRUE');
      console.log('Migration: Added service_message_allowed to messages');
    } catch (e) {
      console.log('Migration note for service_message_allowed:', e.message.split('\n')[0]);
    }
    
    // Add instagram_user_id to clients if not exists
    try {
      await client.query('ALTER TABLE clients ADD COLUMN IF NOT EXISTS instagram_user_id TEXT');
      console.log('Migration: Added instagram_user_id to clients');
    } catch (e) {
      console.log('Migration note for instagram_user_id:', e.message.split('\n')[0]);
    }
    
    console.log('Migrations completed');
    
    // Create default super_admin user if none exists
    console.log('Checking for existing super_admins...');
    const superAdmins = await pool.query('SELECT id FROM super_admins LIMIT 1');
    console.log('Super admins found:', superAdmins.rows.length);
    if (superAdmins.rows.length === 0) {
      console.log('Creating default super_admin user...');
      const defaultPassword = await bcrypt.hash('superadmin123', 10);
      await pool.query(
        'INSERT INTO super_admins (username, password, role) VALUES ($1, $2, $3)',
        ['superadmin', defaultPassword, 'super_admin']
      );
      console.log('Default super_admin user created: superadmin / superadmin123');
    } else {
      console.log('Super admins already exist, skipping default user creation');
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
  pool,
  encrypt,
  decrypt
};
