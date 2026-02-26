const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { initDb, runQuery, runInsert, runUpdate, runDelete } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'crm-secret-key-change-in-production';
const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0';

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || '';
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID || '';
const WHATSAPP_WEBHOOK_VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || '';

const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN || '';
const INSTAGRAM_BUSINESS_ACCOUNT_ID = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID || '';
const INSTAGRAM_WEBHOOK_VERIFY_TOKEN = process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN || WHATSAPP_WEBHOOK_VERIFY_TOKEN;

function normalizePhone(value = '') {
  return String(value).replace(/\D/g, '');
}

function normalizeInstagram(value = '') {
  return String(value).trim().replace(/^@+/, '').toLowerCase();
}

function normalizeIncomingText(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return '[Mensaje no textual]';
}

async function graphApiRequest(pathname, token, body, method = 'POST') {
  const response = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const details = data?.error?.message || JSON.stringify(data);
    throw new Error(details || 'Graph API request failed');
  }
  return data;
}

async function findOrCreateWhatsappClient(fromPhone, profileName) {
  const normalized = normalizePhone(fromPhone);
  const existing = await runQuery(
    "SELECT * FROM clients WHERE regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $1 LIMIT 1",
    [normalized]
  );

  if (existing.length > 0) {
    if (!existing[0].whatsapp) {
      await runUpdate('UPDATE clients SET whatsapp = 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [existing[0].id]);
      existing[0].whatsapp = 1;
    }
    return existing[0];
  }

  const displayName = (profileName && profileName.trim()) || `WhatsApp ${normalized.slice(-4) || 'nuevo'}`;
  const insertResult = await runInsert(
    'INSERT INTO clients (name, phone, whatsapp, conversation_status) VALUES ($1, $2, $3, $4) RETURNING id',
    [displayName, fromPhone || null, 1, 'nuevo']
  );

  const created = await runQuery('SELECT * FROM clients WHERE id = $1', [insertResult.lastInsertRowid]);
  return created[0];
}

async function getInstagramUsername(igUserId) {
  if (!INSTAGRAM_ACCESS_TOKEN) return null;
  try {
    const data = await graphApiRequest(`${igUserId}?fields=username`, INSTAGRAM_ACCESS_TOKEN, null, 'GET');
    return data?.username ? normalizeInstagram(data.username) : null;
  } catch (error) {
    console.log('Instagram username lookup failed:', error.message);
    return null;
  }
}

async function findOrCreateInstagramClient(igUserId) {
  const existingById = await runQuery('SELECT * FROM clients WHERE instagram_user_id = $1 LIMIT 1', [igUserId]);
  if (existingById.length > 0) {
    if (!existingById[0].instagram_active) {
      await runUpdate('UPDATE clients SET instagram_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [existingById[0].id]);
      existingById[0].instagram_active = 1;
    }
    return existingById[0];
  }

  const username = await getInstagramUsername(igUserId);
  if (username) {
    const existingByHandle = await runQuery(
      "SELECT * FROM clients WHERE LOWER(TRIM(BOTH '@' FROM COALESCE(instagram, ''))) = $1 LIMIT 1",
      [username]
    );

    if (existingByHandle.length > 0) {
      await runUpdate(
        'UPDATE clients SET instagram_user_id = $1, instagram_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [igUserId, existingByHandle[0].id]
      );
      existingByHandle[0].instagram_user_id = igUserId;
      existingByHandle[0].instagram_active = 1;
      return existingByHandle[0];
    }
  }

  const fallbackHandle = username || `ig_${igUserId}`;
  const insertResult = await runInsert(
    'INSERT INTO clients (name, instagram, instagram_user_id, instagram_active, conversation_status) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [fallbackHandle, fallbackHandle, igUserId, 1, 'nuevo']
  );

  const created = await runQuery('SELECT * FROM clients WHERE id = $1', [insertResult.lastInsertRowid]);
  return created[0];
}

async function sendWhatsAppMessage(client, messageText) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) {
    throw new Error('WhatsApp is not configured. Missing WHATSAPP_TOKEN or WHATSAPP_PHONE_ID');
  }

  const to = normalizePhone(client.phone);
  if (!to) throw new Error('El cliente no tiene telefono valido para WhatsApp');

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { body: messageText }
  };

  return graphApiRequest(`${WHATSAPP_PHONE_ID}/messages`, WHATSAPP_TOKEN, payload);
}

async function sendInstagramMessage(client, messageText) {
  if (!INSTAGRAM_ACCESS_TOKEN || !INSTAGRAM_BUSINESS_ACCOUNT_ID) {
    throw new Error('Instagram is not configured. Missing INSTAGRAM_ACCESS_TOKEN or INSTAGRAM_BUSINESS_ACCOUNT_ID');
  }

  let recipientId = client.instagram_user_id;
  if (!recipientId && /^\d+$/.test(String(client.instagram || ''))) {
    recipientId = String(client.instagram);
  }

  if (!recipientId) {
    throw new Error('El cliente no tiene instagram_user_id. Espera un mensaje entrante primero o cargalo manualmente.');
  }

  const payload = {
    recipient: { id: recipientId },
    message: { text: messageText }
  };

  return graphApiRequest(`${INSTAGRAM_BUSINESS_ACCOUNT_ID}/messages`, INSTAGRAM_ACCESS_TOKEN, payload);
}

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Auth middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) return res.status(401).json({ error: 'Access denied' });
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
}

// ==================== AUTH API ====================

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    console.log('Login attempt for user:', username);
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    }
    
    const users = await runQuery('SELECT * FROM users WHERE username = $1', [username]);
    console.log('Users found in DB:', users.length);
    console.log('User data:', users[0] ? { id: users[0].id, username: users[0].username, role: users[0].role } : 'none');
    
    if (users.length === 0) return res.status(400).json({ error: 'Usuario o contraseña incorrecta' });
    
    const user = users[0];
    
    let validPassword = false;
    try {
      validPassword = await bcrypt.compare(password, user.password);
      console.log('Password valid:', validPassword);
    } catch (err) {
      console.log('Bcrypt error:', err.message);
      return res.status(500).json({ error: 'Error comparing password: ' + err.message });
    }
    
    if (!validPassword) return res.status(400).json({ error: 'Usuario o contraseña incorrecta' });
    
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
    
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Verify token
app.get('/api/auth/verify', authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

// Create admin user (only with secret key)
app.post('/api/auth/create-admin', async (req, res) => {
  try {
    const { secret_key, username, password } = req.body;
    
    // Verify secret key (change this in production!)
    const ADMIN_SECRET = process.env.ADMIN_SECRET || 'crm-admin-secret';
    if (secret_key !== ADMIN_SECRET) {
      return res.status(403).json({ error: 'Clave secreta incorrecta' });
    }
    
    const existing = await runQuery('SELECT id FROM users WHERE username = $1', [username]);
    if (existing.length > 0) return res.status(400).json({ error: 'El usuario ya existe' });
    
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const result = await runInsert(
      'INSERT INTO users (username, password, role) VALUES ($1, $2, $3) RETURNING id',
      [username, hashedPassword, 'admin']
    );
    
    res.status(201).json({ message: 'Usuario administrador creado', id: result.lastInsertRowid });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Change password
app.post('/api/auth/change-password', authenticateToken, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    const userId = req.user.id;
    
    const users = await runQuery('SELECT password FROM users WHERE id = $1', [userId]);
    if (users.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    
    const validPassword = await bcrypt.compare(current_password, users[0].password);
    if (!validPassword) return res.status(400).json({ error: 'Contraseña actual incorrecta' });
    
    const hashedNewPassword = await bcrypt.hash(new_password, 10);
    
    await runUpdate(
      'UPDATE users SET password = $1 WHERE id = $2',
      [hashedNewPassword, userId]
    );
    
    res.json({ message: 'Contraseña cambiada exitosamente' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reset admin password (debug endpoint - remove in production)
app.post('/api/auth/reset-admin', async (req, res) => {
  try {
    const { secret } = req.body;
    
    // Simple secret to prevent unauthorized resets
    if (secret !== 'reset-admin-123') {
      return res.status(403).json({ error: 'Invalid secret' });
    }
    
    // Generate fresh hash
    const plainPassword = 'admin123';
    const newHash = await bcrypt.hash(plainPassword, 10);
    console.log('New hash generated:', newHash);
    
    // Test if new hash works
    const testResult = await bcrypt.compare(plainPassword, newHash);
    console.log('New hash test result:', testResult);
    
    // Delete existing admin and create new one
    await runDelete('DELETE FROM users WHERE username = $1', ['admin']);
    
    const result = await runInsert(
      'INSERT INTO users (username, password, role) VALUES ($1, $2, $3) RETURNING id',
      ['admin', newHash, 'admin']
    );
    
    // Verify the inserted user
    const verifyUsers = await runQuery('SELECT * FROM users WHERE username = $1', ['admin']);
    const verifyTest = await bcrypt.compare(plainPassword, verifyUsers[0].password);
    console.log('Verification test:', verifyTest);
    
    res.json({ 
      message: 'Admin password reset successfully', 
      id: result.lastInsertRowid, 
      newHashTest: testResult,
      verificationTest: verifyTest
    });
  } catch (error) {
    console.log('Reset error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== CLIENTS API ====================
async function startServer() {
  try {
    await initDb();
    console.log('Database initialized successfully');
    
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// ==================== CLIENTS API ====================

// Get all clients
app.get('/api/clients', authenticateToken, async (req, res) => {
  try {
    const clients = await runQuery('SELECT * FROM clients ORDER BY created_at DESC');
    res.json(clients);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single client
app.get('/api/clients/:id', authenticateToken, async (req, res) => {
  try {
    const clients = await runQuery('SELECT * FROM clients WHERE id = $1', [parseInt(req.params.id)]);
    if (clients.length === 0) return res.status(404).json({ error: 'Client not found' });
    res.json(clients[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create client
app.post('/api/clients', authenticateToken, async (req, res) => {
  try {
    const { name, phone, email, instagram, instagram_user_id, whatsapp } = req.body;
    const result = await runInsert(
      'INSERT INTO clients (name, phone, email, instagram, instagram_user_id, whatsapp) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [name, phone || null, email || null, instagram || null, instagram_user_id || null, whatsapp ? 1 : 0]
    );
    res.status(201).json({ id: result.lastInsertRowid, name, phone, email, instagram, instagram_user_id, whatsapp });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update client
app.put('/api/clients/:id', authenticateToken, async (req, res) => {
  try {
    const { name, phone, email, instagram, instagram_user_id, whatsapp, instagram_active } = req.body;
    await runUpdate(
      'UPDATE clients SET name = $1, phone = $2, email = $3, instagram = $4, instagram_user_id = $5, whatsapp = $6, instagram_active = $7, updated_at = CURRENT_TIMESTAMP WHERE id = $8',
      [name, phone || null, email || null, instagram || null, instagram_user_id || null, whatsapp ? 1 : 0, instagram_active ? 1 : 0, parseInt(req.params.id)]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete client
app.delete('/api/clients/:id', authenticateToken, async (req, res) => {
  try {
    await runDelete('DELETE FROM clients WHERE id = $1', [parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update conversation status
app.patch('/api/clients/:id/status', async (req, res) => {
  try {
    const { conversation_status } = req.body;
    await runUpdate(
      'UPDATE clients SET conversation_status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [conversation_status, parseInt(req.params.id)]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Auto-update stale conversations (7+ days without activity)
app.post('/api/clients/check-stale', async (req, res) => {
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const dateStr = sevenDaysAgo.toISOString();
    
    const staleClients = await runQuery(`
      SELECT c.id, c.conversation_status,
        (SELECT created_at FROM messages WHERE client_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message
      FROM clients c
      WHERE (c.whatsapp = 1 OR c.instagram_active = 1)
        AND c.conversation_status NOT IN ('completado', 'cancelado', 'pagado')
    `);
    
    let updated = 0;
    for (const client of staleClients) {
      if (!client.last_message || new Date(client.last_message) < new Date(dateStr)) {
        if (client.conversation_status !== 'nuevo') {
          await runUpdate(
            'UPDATE clients SET conversation_status = $1 WHERE id = $2',
            ['nuevo', client.id]
          );
          updated++;
        }
      } else if (new Date(client.last_message) >= new Date(dateStr)) {
        if (client.conversation_status === 'nuevo') {
          await runUpdate(
            'UPDATE clients SET conversation_status = $1 WHERE id = $2',
            ['en_proceso', client.id]
          );
          updated++;
        }
      }
    }
    
    res.json({ success: true, updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== PRODUCTS API ====================

// Get all products
app.get('/api/products', async (req, res) => {
  try {
    const products = await runQuery('SELECT * FROM products ORDER BY created_at DESC');
    res.json(products);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get low stock products
app.get('/api/products/low-stock', async (req, res) => {
  try {
    const products = await runQuery('SELECT * FROM products WHERE stock <= min_stock ORDER BY stock ASC');
    res.json(products);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single product
app.get('/api/products/:id', async (req, res) => {
  try {
    const products = await runQuery('SELECT * FROM products WHERE id = $1', [parseInt(req.params.id)]);
    if (products.length === 0) return res.status(404).json({ error: 'Product not found' });
    res.json(products[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create product
app.post('/api/products', async (req, res) => {
  try {
    const { name, description, category, size, color, price, cost, stock, min_stock, image_url } = req.body;
    const result = await runInsert(
      'INSERT INTO products (name, description, category, size, color, price, cost, stock, min_stock, image_url) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id',
      [name, description || null, category || null, size || null, color || null, price, cost || 0, stock || 0, min_stock || 5, image_url || null]
    );
    res.status(201).json({ id: result.lastInsertRowid, name, price, stock });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update product
app.put('/api/products/:id', async (req, res) => {
  try {
    const { name, description, category, size, color, price, cost, stock, min_stock, image_url } = req.body;
    await runUpdate(
      'UPDATE products SET name = $1, description = $2, category = $3, size = $4, color = $5, price = $6, cost = $7, stock = $8, min_stock = $9, image_url = $10, updated_at = CURRENT_TIMESTAMP WHERE id = $11',
      [name, description || null, category || null, size || null, color || null, price, cost || 0, stock || 0, min_stock || 5, image_url || null, parseInt(req.params.id)]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update stock
app.patch('/api/products/:id/stock', async (req, res) => {
  try {
    const { quantity } = req.body;
    const products = await runQuery('SELECT stock FROM products WHERE id = $1', [parseInt(req.params.id)]);
    if (products.length === 0) return res.status(404).json({ error: 'Product not found' });
    
    const newStock = products[0].stock + quantity;
    if (newStock < 0) return res.status(400).json({ error: 'Insufficient stock' });
    
    await runUpdate('UPDATE products SET stock = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [newStock, parseInt(req.params.id)]);
    res.json({ success: true, newStock });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete product
app.delete('/api/products/:id', async (req, res) => {
  try {
    await runDelete('DELETE FROM products WHERE id = $1', [parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== MESSAGES API ====================

// Get messages for a client
app.get('/api/messages/:clientId', async (req, res) => {
  try {
    const messages = await runQuery(
      'SELECT * FROM messages WHERE client_id = $1 ORDER BY created_at ASC',
      [parseInt(req.params.clientId)]
    );
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all conversations (latest message per client)
app.get('/api/conversations', async (req, res) => {
  try {
    const clients = await runQuery(
      "SELECT * FROM clients WHERE whatsapp = 1 OR instagram_active = 1 ORDER BY created_at DESC"
    );
    
    const conversations = await Promise.all(clients.map(async (client) => {
      const lastMessages = await runQuery(
        'SELECT message_text, created_at FROM messages WHERE client_id = $1 ORDER BY created_at DESC LIMIT 1',
        [client.id]
      );
      
      const unreadCount = await runQuery(
        "SELECT COUNT(*) as count FROM messages WHERE client_id = $1 AND direction = 'inbound' AND status = 'sent'",
        [client.id]
      );
      
      return {
        ...client,
        last_message: lastMessages.length > 0 ? lastMessages[0].message_text : null,
        last_message_at: lastMessages.length > 0 ? lastMessages[0].created_at : null,
        unread_count: unreadCount.length > 0 ? parseInt(unreadCount[0].count) : 0
      };
    }));
    
    conversations.sort((a, b) => {
      if (!a.last_message_at) return 1;
      if (!b.last_message_at) return -1;
      return new Date(b.last_message_at) - new Date(a.last_message_at);
    });
    
    res.json(conversations);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send message through WhatsApp/Instagram Graph API
app.post('/api/messages', async (req, res) => {
  try {
    const { client_id, platform, message_text } = req.body;
    const normalizedPlatform = String(platform || '').toLowerCase();
    const parsedClientId = parseInt(client_id, 10);

    if (!parsedClientId || !['whatsapp', 'instagram'].includes(normalizedPlatform)) {
      return res.status(400).json({ error: 'Datos de mensaje invalidos' });
    }

    if (!message_text || !String(message_text).trim()) {
      return res.status(400).json({ error: 'El mensaje no puede estar vacio' });
    }

    const clients = await runQuery('SELECT * FROM clients WHERE id = $1', [parsedClientId]);
    if (clients.length === 0) return res.status(404).json({ error: 'Cliente no encontrado' });

    const client = clients[0];
    let providerResponse;

    if (normalizedPlatform === 'whatsapp') {
      providerResponse = await sendWhatsAppMessage(client, String(message_text).trim());
    } else {
      providerResponse = await sendInstagramMessage(client, String(message_text).trim());
    }

    const providerMessageId =
      providerResponse?.messages?.[0]?.id ||
      providerResponse?.message_id ||
      providerResponse?.id ||
      null;

    const insertResult = await runInsert(
      'INSERT INTO messages (client_id, platform, message_text, direction, status, message_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [parsedClientId, normalizedPlatform, String(message_text).trim(), 'outbound', 'sent', providerMessageId]
    );

    res.status(201).json({
      id: insertResult.lastInsertRowid,
      client_id: parsedClientId,
      platform: normalizedPlatform,
      message_text: String(message_text).trim(),
      direction: 'outbound',
      status: 'sent',
      message_id: providerMessageId,
      provider: providerResponse
    });
  } catch (error) {
    console.error('Error sending message:', error.message);
    res.status(502).json({ error: error.message });
  }
});

// Simulate receiving a message (for demo purposes)
app.post('/api/messages/receive', async (req, res) => {
  try {
    const { client_id, platform, message_text } = req.body;
    
    const result = await runInsert(
      'INSERT INTO messages (client_id, platform, message_text, direction, status) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [parseInt(client_id), platform, message_text, 'inbound', 'read']
    );
    
    res.status(201).json({ 
      id: result.lastInsertRowid, 
      client_id: parseInt(client_id), 
      platform, 
      message_text, 
      direction: 'inbound',
      status: 'read'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mark messages as read
app.put('/api/messages/read/:clientId', async (req, res) => {
  try {
    await runUpdate(
      "UPDATE messages SET status = 'read' WHERE client_id = $1 AND direction = 'inbound'",
      [parseInt(req.params.clientId)]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== META WEBHOOKS ====================

function verifyWebhookToken(req, res, expectedToken) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && expectedToken && token === expectedToken) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
}

app.get('/api/webhooks/whatsapp', (req, res) => verifyWebhookToken(req, res, WHATSAPP_WEBHOOK_VERIFY_TOKEN));
app.get('/api/webhooks/instagram', (req, res) => verifyWebhookToken(req, res, INSTAGRAM_WEBHOOK_VERIFY_TOKEN));

app.post('/api/webhooks/whatsapp', async (req, res) => {
  try {
    const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];

    for (const entry of entries) {
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];

      for (const change of changes) {
        const value = change?.value || {};

        const statuses = Array.isArray(value.statuses) ? value.statuses : [];
        for (const statusItem of statuses) {
          const providerId = statusItem?.id;
          const status = statusItem?.status;
          if (!providerId || !status) continue;

          await runUpdate('UPDATE messages SET status = $1 WHERE message_id = $2', [status, providerId]);
        }

        const incomingMessages = Array.isArray(value.messages) ? value.messages : [];
        const contacts = Array.isArray(value.contacts) ? value.contacts : [];

        for (const incoming of incomingMessages) {
          const from = incoming?.from;
          if (!from) continue;

          const matchingContact = contacts.find(c => c?.wa_id === from);
          const profileName = matchingContact?.profile?.name || null;
          const messageText = normalizeIncomingText(incoming?.text?.body);
          const messageId = incoming?.id || null;

          const client = await findOrCreateWhatsappClient(from, profileName);

          const alreadyStored = messageId
            ? await runQuery('SELECT id FROM messages WHERE message_id = $1 LIMIT 1', [messageId])
            : [];
          if (alreadyStored.length > 0) continue;

          await runInsert(
            'INSERT INTO messages (client_id, platform, message_text, direction, status, message_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
            [client.id, 'whatsapp', messageText, 'inbound', 'sent', messageId]
          );
        }
      }
    }

    res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    console.error('WhatsApp webhook error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/webhooks/instagram', async (req, res) => {
  try {
    const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];

    for (const entry of entries) {
      const messaging = Array.isArray(entry?.messaging) ? entry.messaging : [];

      for (const event of messaging) {
        const senderId = event?.sender?.id ? String(event.sender.id) : null;
        const messageText = event?.message?.text ? normalizeIncomingText(event.message.text) : null;
        const messageId = event?.message?.mid || event?.message?.id || null;

        if (!senderId || !messageText) continue;
        if (INSTAGRAM_BUSINESS_ACCOUNT_ID && senderId === INSTAGRAM_BUSINESS_ACCOUNT_ID) continue;

        const client = await findOrCreateInstagramClient(senderId);

        const alreadyStored = messageId
          ? await runQuery('SELECT id FROM messages WHERE message_id = $1 LIMIT 1', [messageId])
          : [];
        if (alreadyStored.length > 0) continue;

        await runInsert(
          'INSERT INTO messages (client_id, platform, message_text, direction, status, message_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
          [client.id, 'instagram', messageText, 'inbound', 'sent', messageId]
        );
      }
    }

    res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    console.error('Instagram webhook error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==================== SALES API ====================

// Get all sales
app.get('/api/sales', async (req, res) => {
  try {
    const sales = await runQuery(`
      SELECT s.*, c.name as client_name
      FROM sales s
      LEFT JOIN clients c ON s.client_id = c.id
      ORDER BY s.created_at DESC
    `);
    res.json(sales);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single sale with items
app.get('/api/sales/:id', async (req, res) => {
  try {
    const sales = await runQuery(`
      SELECT s.*, c.name as client_name, c.phone as client_phone
      FROM sales s
      LEFT JOIN clients c ON s.client_id = c.id
      WHERE s.id = $1
    `, [parseInt(req.params.id)]);
    
    if (sales.length === 0) return res.status(404).json({ error: 'Sale not found' });
    
    const sale = sales[0];
    const items = await runQuery(`
      SELECT si.*, p.name as product_name, p.size, p.color
      FROM sale_items si
      JOIN products p ON si.product_id = p.id
      WHERE si.sale_id = $1
    `, [sale.id]);
    
    res.json({ ...sale, items });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create sale
app.post('/api/sales', async (req, res) => {
  try {
    const { client_id, items, payment_method, notes } = req.body;
    
    let total = 0;
    for (const item of items) {
      total += item.unit_price * item.quantity;
    }
    
    const saleResult = await runInsert(
      'INSERT INTO sales (client_id, total, payment_method, status, payment_status) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [client_id || null, total, payment_method || 'cash', 'completed', 'paid']
    );
    const saleId = saleResult.lastInsertRowid;
    
    for (const item of items) {
      const subtotal = item.unit_price * item.quantity;
      await runInsert(
        'INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, subtotal) VALUES ($1, $2, $3, $4, $5)',
        [saleId, item.product_id, item.quantity, item.unit_price, subtotal]
      );
      
      await runUpdate('UPDATE products SET stock = stock - $1 WHERE id = $2', [item.quantity, item.product_id]);
    }
    
    await runInsert(
      'INSERT INTO payments (sale_id, amount, payment_method, status, payment_date) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)',
      [saleId, total, payment_method || 'cash', 'completed']
    );
    
    res.status(201).json({ id: saleId, total, status: 'completed' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update sale status
app.put('/api/sales/:id/status', async (req, res) => {
  try {
    const { status, payment_status } = req.body;
    await runUpdate(
      'UPDATE sales SET status = $1, payment_status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [status, payment_status || null, parseInt(req.params.id)]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cancel sale (restore stock)
app.delete('/api/sales/:id', async (req, res) => {
  try {
    const sales = await runQuery('SELECT * FROM sales WHERE id = $1', [parseInt(req.params.id)]);
    if (sales.length === 0) return res.status(404).json({ error: 'Sale not found' });
    
    const sale = sales[0];
    
    const items = await runQuery('SELECT * FROM sale_items WHERE sale_id = $1', [sale.id]);
    for (const item of items) {
      await runUpdate('UPDATE products SET stock = stock + $1 WHERE id = $2', [item.quantity, item.product_id]);
    }
    
    await runUpdate('UPDATE sales SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', ['cancelled', parseInt(req.params.id)]);
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== PAYMENTS API ====================

// Get payments for a sale
app.get('/api/payments/:saleId', async (req, res) => {
  try {
    const payments = await runQuery(
      'SELECT * FROM payments WHERE sale_id = $1 ORDER BY created_at DESC',
      [parseInt(req.params.saleId)]
    );
    res.json(payments);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all payments
app.get('/api/payments', async (req, res) => {
  try {
    const payments = await runQuery(`
      SELECT p.*, s.id as sale_id, s.total as sale_total
      FROM payments p
      JOIN sales s ON p.sale_id = s.id
      ORDER BY p.created_at DESC
    `);
    res.json(payments);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create payment
app.post('/api/payments', async (req, res) => {
  try {
    const { sale_id, amount, payment_method, transaction_id } = req.body;
    
    const result = await runInsert(
      'INSERT INTO payments (sale_id, amount, payment_method, status, transaction_id, payment_date) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP) RETURNING id',
      [parseInt(sale_id), amount, payment_method, 'completed', transaction_id || null]
    );
    
    await runUpdate(
      'UPDATE sales SET payment_status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      ['completed', parseInt(sale_id)]
    );
    
    res.status(201).json({ id: result.lastInsertRowid, sale_id: parseInt(sale_id), amount, payment_method, status: 'completed' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== STATS API ====================

// Get dashboard stats
app.get('/api/stats', authenticateToken, async (req, res) => {
  try {
    const totalClients = await runQuery('SELECT COUNT(*) as count FROM clients');
    const totalProducts = await runQuery('SELECT COUNT(*) as count FROM products');
    const lowStockProducts = await runQuery('SELECT COUNT(*) as count FROM products WHERE stock <= min_stock');
    const totalSales = await runQuery("SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as total FROM sales WHERE status = 'completed'");
    const totalPayments = await runQuery("SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE status = 'completed'");
    
    const salesByMonth = await runQuery(`
      SELECT DATE_TRUNC('month', created_at) as month, SUM(total) as total
      FROM sales
      WHERE status = 'completed' AND created_at >= DATE_TRUNC('month', NOW() - INTERVAL '6 months')
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY month
    `);
    
    res.json({
      totalClients: parseInt(totalClients[0]?.count || 0),
      totalProducts: parseInt(totalProducts[0]?.count || 0),
      lowStockProducts: parseInt(lowStockProducts[0]?.count || 0),
      totalSales: parseInt(totalSales[0]?.count || 0),
      totalSalesAmount: parseFloat(totalSales[0]?.total || 0),
      totalPayments: parseFloat(totalPayments[0]?.total || 0),
      salesByMonth
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
startServer();
