const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { initDb, runQuery, runInsert, runUpdate, runDelete, pool, encrypt, decrypt } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'crm-secret-key-change-in-production';
const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0';

// Default tokens (for backwards compatibility - will be overridden by tenant configs)
const DEFAULT_WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || '';
const DEFAULT_WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID || '';
const DEFAULT_WHATSAPP_WEBHOOK_VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || 'whatsapp_verify_token';
const DEFAULT_INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN || '';
const DEFAULT_INSTAGRAM_BUSINESS_ACCOUNT_ID = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID || '';
const DEFAULT_INSTAGRAM_WEBHOOK_VERIFY_TOKEN = process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN || 'instagram_verify_token';

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

function generateSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .substring(0, 50);
}

// ==================== TENANT CONFIG HELPERS ====================

async function getTenantConfig(tenantId) {
  const configs = await runQuery('SELECT * FROM tenant_configs WHERE tenant_id = $1', [tenantId]);
  return configs[0] || null;
}

async function getTenantWhatsAppCredentials(tenantId) {
  const config = await getTenantConfig(tenantId);
  if (!config || !config.whatsapp_enabled) {
    // Fall back to default if no tenant-specific config
    if (DEFAULT_WHATSAPP_TOKEN && DEFAULT_WHATSAPP_PHONE_ID) {
      return {
        token: DEFAULT_WHATSAPP_TOKEN,
        phoneId: DEFAULT_WHATSAPP_PHONE_ID,
        webhookVerifyToken: DEFAULT_WHATSAPP_WEBHOOK_VERIFY_TOKEN,
        isDefault: true
      };
    }
    return null;
  }
  return {
    token: decrypt(config.whatsapp_token),
    phoneId: config.whatsapp_phone_id,
    businessAccountId: config.whatsapp_business_account_id,
    webhookVerifyToken: config.whatsapp_webhook_verify_token,
    isDefault: false
  };
}

async function getTenantInstagramCredentials(tenantId) {
  const config = await getTenantConfig(tenantId);
  if (!config || !config.instagram_enabled) {
    // Fall back to default if no tenant-specific config
    if (DEFAULT_INSTAGRAM_ACCESS_TOKEN && DEFAULT_INSTAGRAM_BUSINESS_ACCOUNT_ID) {
      return {
        token: DEFAULT_INSTAGRAM_ACCESS_TOKEN,
        businessAccountId: DEFAULT_INSTAGRAM_BUSINESS_ACCOUNT_ID,
        webhookVerifyToken: DEFAULT_INSTAGRAM_WEBHOOK_VERIFY_TOKEN,
        isDefault: true
      };
    }
    return null;
  }
  return {
    token: decrypt(config.instagram_access_token),
    businessAccountId: config.instagram_business_account_id,
    webhookVerifyToken: config.instagram_webhook_verify_token,
    isDefault: false
  };
}

// ==================== MESSAGE CONTROLS ====================

const MESSAGE_TYPES = {
  SERVICE: 'service',
  MARKETING: 'marketing',
  TRANSACTIONAL: 'transactional'
};

async function checkMessageLimits(tenantId) {
  const tenants = await runQuery('SELECT * FROM tenants WHERE id = $1', [tenantId]);
  if (tenants.length === 0) {
    throw new Error('Tenant no encontrado');
  }
  
  const tenant = tenants[0];
  const config = await getTenantConfig(tenantId);
  
  if (tenant.status !== 'active') {
    throw new Error('Tenant no activo. Esperar aprobación del administrador.');
  }
  
  const today = new Date().toISOString().split('T')[0];
  
  // Reset daily counter if needed
  if (tenant.last_message_reset !== today) {
    await runUpdate(
      'UPDATE tenants SET messages_sent_today = 0, last_message_reset = $1 WHERE id = $2',
      [today, tenantId]
    );
    tenant.messages_sent_today = 0;
  }
  
  const maxDaily = config?.max_messages_per_day || 100;
  const maxMonthly = config?.max_messages_per_month || 1000;
  
  // Check daily limit
  if (tenant.messages_sent_today >= maxDaily) {
    throw new Error(`Límite diario de mensajes alcanzado (${maxDaily}). Intenta mañana.`);
  }
  
  // Check monthly limit
  if (tenant.messages_sent_monthly >= maxMonthly) {
    throw new Error(`Límite mensual de mensajes alcanzado (${maxMonthly}). Intenta el próximo mes.`);
  }
  
  return { tenant, config, maxDaily, maxMonthly };
}

async function check24HourWindow(clientId, direction) {
  // Get the last message from the client (inbound)
  const lastClientMessage = await runQuery(
    'SELECT * FROM messages WHERE client_id = $1 AND direction = $2 ORDER BY created_at DESC LIMIT 1',
    [clientId, 'inbound']
  );
  
  if (lastClientMessage.length === 0) {
    // No previous inbound message - this would be initiating a conversation
    return { allowed: false, reason: 'No hay conversación activa. Solo puedes responder a mensajes entrantes.' };
  }
  
  const lastMessage = lastClientMessage[0];
  
  // Check if there's an expiration timestamp from WhatsApp
  if (lastMessage.message_expiration) {
    const expirationTime = new Date(lastMessage.message_expiration).getTime();
    const now = Date.now();
    
    if (now > expirationTime) {
      // Window has expired according to WhatsApp's timestamp
      return { 
        allowed: false, 
        reason: 'Ventana de 24hs cerrada según WhatsApp. Puedes enviar mensajes de marketing si está habilitado.',
        expired: true,
        canSendMarketing: true
      };
    }
    
    // Still within the WhatsApp window
    return { allowed: true, lastMessage, expiresAt: lastMessage.message_expiration };
  }
  
  // Fallback: Calculate from our timestamp
  const hoursDiff = (Date.now() - new Date(lastMessage.created_at).getTime()) / (1000 * 60 * 60);
  
  if (hoursDiff > 24) {
    return { 
      allowed: false, 
      reason: `Ventana de 24hs cerrada. El último mensaje del cliente fue hace ${Math.floor(hoursDiff)} horas.`,
      expired: true,
      canSendMarketing: true
    };
  }
  
  return { allowed: true, lastMessage };
}

async function canSendMessage(tenantId, clientId, messageType = MESSAGE_TYPES.SERVICE) {
  const { tenant, config } = await checkMessageLimits(tenantId);
  
  // Check if marketing messages are allowed
  if (messageType === MESSAGE_TYPES.MARKETING) {
    if (!config?.allow_marketing_messages) {
      throw new Error('Mensajes de marketing no permitidos. Habilita esta opción en Configuración para enviar mensajes fuera de la ventana de 24hs.');
    }
    // Marketing messages are allowed - no time restriction
    return { allowed: true, messageType: 'marketing', isFree: false };
  }
  
  // For service messages, check 24-hour window
  const windowCheck = await check24HourWindow(clientId, 'outbound');
  
  if (!windowCheck.allowed) {
    // Service message not allowed (outside 24hs window)
    // Check if marketing is available as alternative
    if (config?.allow_marketing_messages) {
      throw new Error(windowCheck.reason + ' Puedes habilitar mensajes de marketing en Configuración para enviar fuera de la ventana.');
    }
    throw new Error(windowCheck.reason);
  }
  
  return { allowed: true, messageType: 'service', isFree: true, expiresAt: windowCheck.expiresAt };
}

async function incrementMessageCount(tenantId) {
  await runUpdate(
    'UPDATE tenants SET messages_sent_today = messages_sent_today + 1, messages_sent_monthly = messages_sent_monthly + 1 WHERE id = $1',
    [tenantId]
  );
}

// ==================== GRAPH API REQUEST ====================

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

// ==================== CLIENT FIND/CREATE ====================

async function findOrCreateWhatsappClient(tenantId, fromPhone, profileName) {
  const normalized = normalizePhone(fromPhone);
  const existing = await runQuery(
    "SELECT * FROM clients WHERE tenant_id = $1 AND regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $2 LIMIT 1",
    [tenantId, normalized]
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
    'INSERT INTO clients (tenant_id, name, phone, whatsapp, conversation_status) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [tenantId, displayName, fromPhone || null, 1, 'nuevo']
  );

  const created = await runQuery('SELECT * FROM clients WHERE id = $1', [insertResult.lastInsertRowid]);
  return created[0];
}

async function getInstagramUsername(igUserId, token) {
  if (!token) return null;
  try {
    const data = await graphApiRequest(`${igUserId}?fields=username`, token, null, 'GET');
    return data?.username ? normalizeInstagram(data.username) : null;
  } catch (error) {
    console.log('Instagram username lookup failed:', error.message);
    return null;
  }
}

async function findOrCreateInstagramClient(tenantId, igUserId, token) {
  const existingById = await runQuery(
    'SELECT * FROM clients WHERE tenant_id = $1 AND instagram_user_id = $2 LIMIT 1',
    [tenantId, igUserId]
  );
  
  if (existingById.length > 0) {
    if (!existingById[0].instagram_active) {
      await runUpdate('UPDATE clients SET instagram_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [existingById[0].id]);
      existingById[0].instagram_active = 1;
    }
    return existingById[0];
  }

  const username = await getInstagramUsername(igUserId, token);
  if (username) {
    const existingByHandle = await runQuery(
      "SELECT * FROM clients WHERE tenant_id = $1 AND LOWER(TRIM(BOTH '@' FROM COALESCE(instagram, ''))) = $2 LIMIT 1",
      [tenantId, username]
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
    'INSERT INTO clients (tenant_id, name, instagram, instagram_user_id, instagram_active, conversation_status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [tenantId, fallbackHandle, fallbackHandle, igUserId, 1, 'nuevo']
  );

  const created = await runQuery('SELECT * FROM clients WHERE id = $1', [insertResult.lastInsertRowid]);
  return created[0];
}

// ==================== SEND MESSAGES ====================

async function sendWhatsAppMessage(tenantId, client, messageText) {
  const credentials = await getTenantWhatsAppCredentials(tenantId);
  
  if (!credentials) {
    throw new Error('WhatsApp no está configurado para esta tienda.');
  }

  const to = normalizePhone(client.phone);
  if (!to) throw new Error('El cliente no tiene teléfono válido para WhatsApp');

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { body: messageText }
  };

  return graphApiRequest(`${credentials.phoneId}/messages`, credentials.token, payload);
}

async function sendInstagramMessage(tenantId, client, messageText) {
  const credentials = await getTenantInstagramCredentials(tenantId);
  
  if (!credentials) {
    throw new Error('Instagram no está configurado para esta tienda.');
  }

  let recipientId = client.instagram_user_id;
  if (!recipientId && /^\d+$/.test(String(client.instagram || ''))) {
    recipientId = String(client.instagram);
  }

  if (!recipientId) {
    throw new Error('El cliente no tiene instagram_user_id. Espera un mensaje entrante primero o cárgalo manualmente.');
  }

  const payload = {
    recipient: { id: recipientId },
    message: { text: messageText }
  };

  return graphApiRequest(`${credentials.businessAccountId}/messages`, credentials.token, payload);
}

// ==================== MIDDLEWARE ====================

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Auth middleware - supports both super_admin and tenant users
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

// Super admin middleware
function requireSuperAdmin(req, res, next) {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Acceso denegado. Se requiere权限 de super administrador.' });
  }
  next();
}

// Tenant middleware - require active tenant
function requireActiveTenant(req, res, next) {
  if (!req.user.tenant_id) {
    return res.status(403).json({ error: 'Acceso denegado. Se requiere ser usuario de una tienda.' });
  }
  if (req.user.tenant_status !== 'active') {
    return res.status(403).json({ error: `Tu tienda está ${req.user.tenant_status}. Contacta al administrador.` });
  }
  req.tenantId = req.user.tenant_id;
  next();
}

// ==================== AUTH API ====================

// Login - detects if super_admin, tenant, or legacy user
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    }
    
    // Check super_admins first
    let users = await runQuery('SELECT * FROM super_admins WHERE username = $1', [username]);
    let isSuperAdmin = true;
    let isLegacyUser = false;
    let legacyTenantId = null;
    
    if (users.length === 0) {
      // Check tenants
      users = await runQuery('SELECT * FROM tenants WHERE owner_email = $1 OR slug = $1', [username]);
      isSuperAdmin = false;
      
      // If not found in tenants, check legacy users table
      if (users.length === 0) {
        const legacyUsers = await runQuery('SELECT * FROM users WHERE username = $1', [username]);
        if (legacyUsers.length > 0) {
          users = legacyUsers;
          isLegacyUser = true;
          // Legacy users get tenant_id = 1 by default (or we can assign them)
          legacyTenantId = 1;
        }
      }
    }
    
    if (users.length === 0) {
      return res.status(400).json({ error: 'Usuario o contraseña incorrecta' });
    }
    
    const user = users[0];
    let validPassword = false;
    
    try {
      validPassword = await bcrypt.compare(password, user.password);
    } catch (err) {
      return res.status(500).json({ error: 'Error comparing password: ' + err.message });
    }
    
    if (!validPassword) return res.status(400).json({ error: 'Usuario o contraseña incorrecta' });
    
    // Check tenant status (skip for super admin and legacy users)
    if (!isSuperAdmin && !isLegacyUser && user.status !== 'active') {
      return res.status(403).json({ 
        error: `Tu tienda está ${user.status}. Esperar aprobación o contactar al administrador.`,
        status: user.status
      });
    }
    
    // Build token payload
    let tokenPayload;
    if (isSuperAdmin) {
      tokenPayload = { id: user.id, username: user.username, role: user.role };
    } else if (isLegacyUser) {
      // Legacy users get tenant_admin role with tenant_id = 1
      tokenPayload = { 
        id: user.id, 
        username: user.username, 
        role: 'tenant_admin', 
        tenant_id: legacyTenantId, 
        tenant_status: 'active',
        tenant_name: 'Mi Tienda',
        tenant_slug: 'mi-tienda'
      };
    } else {
      tokenPayload = { 
        id: user.id, 
        username: user.owner_name, 
        role: 'tenant_admin', 
        tenant_id: user.id,
        tenant_status: user.status, 
        tenant_name: user.name, 
        tenant_slug: user.slug 
      };
    }
    
    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '24h' });
    
    // Update last login for super admin
    if (isSuperAdmin) {
      await runUpdate('UPDATE super_admins SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);
    }
    
    res.json({ 
      token, 
      user: tokenPayload,
      isSuperAdmin,
      isLegacyUser 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Verify token
app.get('/api/auth/verify', authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

// Create super admin (only with secret key)
app.post('/api/auth/create-super-admin', async (req, res) => {
  try {
    const { secret_key, username, password } = req.body;
    
    const ADMIN_SECRET = process.env.ADMIN_SECRET || 'crm-admin-secret';
    if (secret_key !== ADMIN_SECRET) {
      return res.status(403).json({ error: 'Clave secreta incorrecta' });
    }
    
    const existing = await runQuery('SELECT id FROM super_admins WHERE username = $1', [username]);
    if (existing.length > 0) return res.status(400).json({ error: 'El usuario ya existe' });
    
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const result = await runInsert(
      'INSERT INTO super_admins (username, password, role) VALUES ($1, $2, $3) RETURNING id',
      [username, hashedPassword, 'super_admin']
    );
    
    res.status(201).json({ message: 'Super administrador creado', id: result.lastInsertRowid });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== TENANT REGISTRATION API ====================

// Register new tenant
app.post('/api/tenants/register', async (req, res) => {
  try {
    const { name, owner_name, owner_email, owner_phone, password } = req.body;
    
    if (!name || !owner_name || !owner_email || !password) {
      return res.status(400).json({ error: 'Todos los campos son requeridos' });
    }
    
    // Check if email already exists
    const existing = await runQuery('SELECT id FROM tenants WHERE owner_email = $1', [owner_email]);
    if (existing.length > 0) {
      return res.status(400).json({ error: 'El email ya está registrado' });
    }
    
    // Generate unique slug
    let slug = generateSlug(name);
    const existingSlug = await runQuery('SELECT id FROM tenants WHERE slug = $1', [slug]);
    if (existingSlug.length > 0) {
      slug = `${slug}-${Date.now()}`;
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const result = await runInsert(
      'INSERT INTO tenants (slug, name, owner_name, owner_email, owner_phone, password, status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [slug, name, owner_name, owner_email, owner_phone || null, hashedPassword, 'pending']
    );
    
    const tenantId = result.lastInsertRowid;
    
    // Create default tenant config
    await runInsert(
      'INSERT INTO tenant_configs (tenant_id) VALUES ($1)',
      [tenantId]
    );
    
    // Log the registration
    await runInsert(
      'INSERT INTO tenant_audit_logs (tenant_id, action, details) VALUES ($1, $2, $3)',
      [tenantId, 'tenant_registered', { name, owner_email }]
    );
    
    res.status(201).json({ 
      message: 'Registro exitoso. Esperar aprobación del administrador.',
      tenant_id: tenantId
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Tenant login
app.post('/api/tenants/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email y contraseña requeridos' });
    }
    
    const tenants = await runQuery('SELECT * FROM tenants WHERE owner_email = $1', [email]);
    
    if (tenants.length === 0) {
      return res.status(400).json({ error: 'Credenciales incorrectas' });
    }
    
    const tenant = tenants[0];
    
    if (tenant.status !== 'active') {
      return res.status(403).json({ 
        error: `Tu tienda está ${tenant.status}. Esperar aprobación o contactar al administrador.`,
        status: tenant.status
      });
    }
    
    const validPassword = await bcrypt.compare(password, tenant.password);
    if (!validPassword) {
      return res.status(400).json({ error: 'Credenciales incorrectas' });
    }
    
    const token = jwt.sign({
      id: tenant.id,
      username: tenant.owner_name,
      role: 'tenant_admin',
      tenant_id: tenant.id,
      tenant_status: tenant.status,
      tenant_name: tenant.name,
      tenant_slug: tenant.slug
    }, JWT_SECRET, { expiresIn: '24h' });
    
    res.json({ 
      token, 
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        owner_name: tenant.owner_name,
        owner_email: tenant.owner_email,
        status: tenant.status,
        plan: tenant.plan
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get tenant profile
app.get('/api/tenants/profile', authenticateToken, requireActiveTenant, async (req, res) => {
  try {
    const tenants = await runQuery('SELECT id, slug, name, owner_name, owner_email, owner_phone, domain, logo_url, status, plan, message_limit_monthly, messages_sent_monthly, messages_sent_today, last_message_reset, created_at FROM tenants WHERE id = $1', [req.tenantId]);
    
    if (tenants.length === 0) {
      return res.status(404).json({ error: 'Tenant no encontrado' });
    }
    
    const config = await getTenantConfig(req.tenantId);
    
    res.json({ ...tenants[0], config });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update tenant profile
app.put('/api/tenants/profile', authenticateToken, requireActiveTenant, async (req, res) => {
  try {
    const { name, owner_name, owner_phone, domain, logo_url } = req.body;
    
    await runUpdate(
      'UPDATE tenants SET name = $1, owner_name = $2, owner_phone = $3, domain = $4, logo_url = $5, updated_at = CURRENT_TIMESTAMP WHERE id = $6',
      [name, owner_name, owner_phone, domain, logo_url, req.tenantId]
    );
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== TENANT CONFIG API ====================

// Get tenant API configuration
app.get('/api/tenants/config', authenticateToken, requireActiveTenant, async (req, res) => {
  try {
    const config = await getTenantConfig(req.tenantId);
    
    if (!config) {
      return res.status(404).json({ error: 'Configuración no encontrada' });
    }
    
    // Return config without sensitive decrypted data for security
    res.json({
      whatsapp_enabled: config.whatsapp_enabled,
      whatsapp_phone_id: config.whatsapp_phone_id ? '***configured***' : null,
      whatsapp_business_account_id: config.whatsapp_business_account_id,
      instagram_enabled: config.instagram_enabled,
      instagram_business_account_id: config.instagram_business_account_id,
      max_messages_per_day: config.max_messages_per_day,
      max_messages_per_month: config.max_messages_per_month,
      allow_marketing_messages: config.allow_marketing_messages,
      response_window_hours: config.response_window_hours,
      allow_initiate_conversation: config.allow_initiate_conversation
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update tenant API configuration
app.put('/api/tenants/config', authenticateToken, requireActiveTenant, async (req, res) => {
  try {
    const {
      whatsapp_token,
      whatsapp_phone_id,
      whatsapp_business_account_id,
      whatsapp_webhook_verify_token,
      whatsapp_enabled,
      instagram_access_token,
      instagram_business_account_id,
      instagram_webhook_verify_token,
      instagram_enabled,
      max_messages_per_day,
      max_messages_per_month,
      allow_marketing_messages,
      response_window_hours,
      allow_initiate_conversation
    } = req.body;
    
    const config = await getTenantConfig(req.tenantId);
    
    if (!config) {
      return res.status(404).json({ error: 'Configuración no encontrada' });
    }
    
    await runUpdate(
      `UPDATE tenant_configs SET 
        whatsapp_token = COALESCE($1, whatsapp_token),
        whatsapp_phone_id = COALESCE($2, whatsapp_phone_id),
        whatsapp_business_account_id = COALESCE($3, whatsapp_business_account_id),
        whatsapp_webhook_verify_token = COALESCE($4, whatsapp_webhook_verify_token),
        whatsapp_enabled = COALESCE($5, whatsapp_enabled),
        instagram_access_token = COALESCE($6, instagram_access_token),
        instagram_business_account_id = COALESCE($7, instagram_business_account_id),
        instagram_webhook_verify_token = COALESCE($8, instagram_webhook_verify_token),
        instagram_enabled = COALESCE($9, instagram_enabled),
        max_messages_per_day = COALESCE($10, max_messages_per_day),
        max_messages_per_month = COALESCE($11, max_messages_per_month),
        allow_marketing_messages = COALESCE($12, allow_marketing_messages),
        response_window_hours = COALESCE($13, response_window_hours),
        allow_initiate_conversation = COALESCE($14, allow_initiate_conversation),
        updated_at = CURRENT_TIMESTAMP
      WHERE tenant_id = $15`,
      [
        whatsapp_token ? encrypt(whatsapp_token) : null,
        whatsapp_phone_id,
        whatsapp_business_account_id,
        whatsapp_webhook_verify_token,
        whatsapp_enabled !== undefined ? whatsapp_enabled : null,
        instagram_access_token ? encrypt(instagram_access_token) : null,
        instagram_business_account_id,
        instagram_webhook_verify_token,
        instagram_enabled !== undefined ? instagram_enabled : null,
        max_messages_per_day,
        max_messages_per_month,
        allow_marketing_messages !== undefined ? allow_marketing_messages : null,
        response_window_hours,
        allow_initiate_conversation !== undefined ? allow_initiate_conversation : null,
        req.tenantId
      ]
    );
    
    res.json({ success: true, message: 'Configuración actualizada' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== SUPER ADMIN API ====================

// Get all tenants
app.get('/api/admin/tenants', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const tenants = await runQuery('SELECT id, slug, name, owner_name, owner_email, owner_phone, status, plan, messages_sent_monthly, messages_sent_today, created_at, approved_at FROM tenants ORDER BY created_at DESC');
    res.json(tenants);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get pending tenants
app.get('/api/admin/tenants/pending', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const tenants = await runQuery("SELECT id, slug, name, owner_name, owner_email, owner_phone, created_at FROM tenants WHERE status = 'pending' ORDER BY created_at ASC");
    res.json(tenants);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single tenant details
app.get('/api/admin/tenants/:id', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const tenants = await runQuery('SELECT * FROM tenants WHERE id = $1', [parseInt(req.params.id)]);
    if (tenants.length === 0) {
      return res.status(404).json({ error: 'Tenant no encontrado' });
    }
    
    const config = await getTenantConfig(parseInt(req.params.id));
    res.json({ ...tenants[0], config });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Approve tenant
app.post('/api/admin/tenants/:id/approve', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const tenantId = parseInt(req.params.id);
    
    const tenants = await runQuery('SELECT * FROM tenants WHERE id = $1', [tenantId]);
    if (tenants.length === 0) {
      return res.status(404).json({ error: 'Tenant no encontrado' });
    }
    
    if (tenants[0].status !== 'pending') {
      return res.status(400).json({ error: 'El tenant no está pendiente' });
    }
    
    await runUpdate(
      "UPDATE tenants SET status = 'active', approved_at = CURRENT_TIMESTAMP, approved_by = $1 WHERE id = $2",
      [req.user.id, tenantId]
    );
    
    await runInsert(
      'INSERT INTO tenant_audit_logs (tenant_id, action, details) VALUES ($1, $2, $3)',
      [tenantId, 'tenant_approved', { approved_by: req.user.id }]
    );
    
    res.json({ success: true, message: 'Tienda aprobada exitosamente' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reject tenant
app.post('/api/admin/tenants/:id/reject', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const tenantId = parseInt(req.params.id);
    const { reason } = req.body;
    
    const tenants = await runQuery('SELECT * FROM tenants WHERE id = $1', [tenantId]);
    if (tenants.length === 0) {
      return res.status(404).json({ error: 'Tenant no encontrado' });
    }
    
    await runUpdate(
      "UPDATE tenants SET status = 'rejected', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
      [tenantId]
    );
    
    await runInsert(
      'INSERT INTO tenant_audit_logs (tenant_id, action, details) VALUES ($1, $2, $3)',
      [tenantId, 'tenant_rejected', { reason: reason || 'Sin motivo especificado', rejected_by: req.user.id }]
    );
    
    res.json({ success: true, message: 'Tienda rechazada' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Suspend tenant
app.post('/api/admin/tenants/:id/suspend', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const tenantId = parseInt(req.params.id);
    
    await runUpdate(
      "UPDATE tenants SET status = 'suspended', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
      [tenantId]
    );
    
    await runInsert(
      'INSERT INTO tenant_audit_logs (tenant_id, action, details) VALUES ($1, $2, $3)',
      [tenantId, 'tenant_suspended', { suspended_by: req.user.id }]
    );
    
    res.json({ success: true, message: 'Tienda suspendida' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reactivate tenant
app.post('/api/admin/tenants/:id/reactivate', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const tenantId = parseInt(req.params.id);
    
    await runUpdate(
      "UPDATE tenants SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
      [tenantId]
    );
    
    await runInsert(
      'INSERT INTO tenant_audit_logs (tenant_id, action, details) VALUES ($1, $2, $3)',
      [tenantId, 'tenant_reactivated', { reactivated_by: req.user.id }]
    );
    
    res.json({ success: true, message: 'Tienda reactivada' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update tenant limits
app.put('/api/admin/tenants/:id/limits', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const tenantId = parseInt(req.params.id);
    const { plan, message_limit_monthly, max_messages_per_day, max_messages_per_month, allow_marketing_messages } = req.body;
    
    await runUpdate(
      'UPDATE tenants SET plan = $1, message_limit_monthly = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [plan, message_limit_monthly, tenantId]
    );
    
    if (max_messages_per_day !== undefined || max_messages_per_month !== undefined || allow_marketing_messages !== undefined) {
      await runUpdate(
        `UPDATE tenant_configs SET 
          max_messages_per_day = COALESCE($1, max_messages_per_day),
          max_messages_per_month = COALESCE($2, max_messages_per_month),
          allow_marketing_messages = COALESCE($3, allow_marketing_messages),
          updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = $4`,
        [max_messages_per_day, max_messages_per_month, allow_marketing_messages !== undefined ? allow_marketing_messages : null, tenantId]
      );
    }
    
    res.json({ success: true, message: 'Límites actualizados' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reset message count
app.post('/api/admin/tenants/:id/reset-count', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const tenantId = parseInt(req.params.id);
    
    await runUpdate(
      'UPDATE tenants SET messages_sent_today = 0, messages_sent_monthly = 0, last_message_reset = NULL WHERE id = $1',
      [tenantId]
    );
    
    res.json({ success: true, message: 'Contador de mensajes reseteado' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get audit logs
app.get('/api/admin/audit-logs', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { tenant_id, limit = 50 } = req.query;
    
    let sql = 'SELECT * FROM tenant_audit_logs';
    let params = [];
    
    if (tenant_id) {
      sql += ' WHERE tenant_id = $1';
      params.push(parseInt(tenant_id));
    }
    
    sql += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
    params.push(parseInt(limit));
    
    const logs = await runQuery(sql, params);
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get admin stats
app.get('/api/admin/stats', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const totalTenants = await runQuery('SELECT COUNT(*) as count FROM tenants');
    const activeTenants = await runQuery("SELECT COUNT(*) as count FROM tenants WHERE status = 'active'");
    const pendingTenants = await runQuery("SELECT COUNT(*) as count FROM tenants WHERE status = 'pending'");
    const suspendedTenants = await runQuery("SELECT COUNT(*) as count FROM tenants WHERE status = 'suspended'");
    
    const totalMessages = await runQuery('SELECT COALESCE(SUM(messages_sent_monthly), 0) as total FROM tenants');
    
    res.json({
      totalTenants: parseInt(totalTenants[0]?.count || 0),
      activeTenants: parseInt(activeTenants[0]?.count || 0),
      pendingTenants: parseInt(pendingTenants[0]?.count || 0),
      suspendedTenants: parseInt(suspendedTenants[0]?.count || 0),
      totalMessagesSent: parseInt(totalMessages[0]?.total || 0)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== CLIENTS API ====================

// Get all clients for tenant
app.get('/api/clients', authenticateToken, requireActiveTenant, async (req, res) => {
  try {
    const clients = await runQuery('SELECT * FROM clients WHERE tenant_id = $1 ORDER BY created_at DESC', [req.tenantId]);
    res.json(clients);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single client
app.get('/api/clients/:id', authenticateToken, requireActiveTenant, async (req, res) => {
  try {
    const clients = await runQuery('SELECT * FROM clients WHERE id = $1 AND tenant_id = $2', [parseInt(req.params.id), req.tenantId]);
    if (clients.length === 0) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json(clients[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create client
app.post('/api/clients', authenticateToken, requireActiveTenant, async (req, res) => {
  try {
    const { name, phone, email, instagram, instagram_user_id, whatsapp } = req.body;
    const result = await runInsert(
      'INSERT INTO clients (tenant_id, name, phone, email, instagram, instagram_user_id, whatsapp) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [req.tenantId, name, phone || null, email || null, instagram || null, instagram_user_id || null, whatsapp ? 1 : 0]
    );
    res.status(201).json({ id: result.lastInsertRowid, name, phone, email, instagram, instagram_user_id, whatsapp });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update client
app.put('/api/clients/:id', authenticateToken, requireActiveTenant, async (req, res) => {
  try {
    const { name, phone, email, instagram, instagram_user_id, whatsapp, instagram_active } = req.body;
    await runUpdate(
      'UPDATE clients SET name = $1, phone = $2, email = $3, instagram = $4, instagram_user_id = $5, whatsapp = $6, instagram_active = $7, updated_at = CURRENT_TIMESTAMP WHERE id = $8 AND tenant_id = $9',
      [name, phone || null, email || null, instagram || null, instagram_user_id || null, whatsapp ? 1 : 0, instagram_active ? 1 : 0, parseInt(req.params.id), req.tenantId]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete client
app.delete('/api/clients/:id', authenticateToken, requireActiveTenant, async (req, res) => {
  try {
    await runDelete('DELETE FROM clients WHERE id = $1 AND tenant_id = $2', [parseInt(req.params.id), req.tenantId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update conversation status
app.patch('/api/clients/:id/status', authenticateToken, requireActiveTenant, async (req, res) => {
  try {
    const { conversation_status } = req.body;
    await runUpdate(
      'UPDATE clients SET conversation_status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND tenant_id = $3',
      [conversation_status, parseInt(req.params.id), req.tenantId]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update conversation checkboxes (presupuesto_enviado, pago_realizado, envio_realizado)
app.patch('/api/clients/:id/checkboxes', authenticateToken, requireActiveTenant, async (req, res) => {
  try {
    const { presupuesto_enviado, pago_realizado, envio_realizado } = req.body;
    await runUpdate(
      'UPDATE clients SET presupuesto_enviado = $1, pago_realizado = $2, envio_realizado = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4 AND tenant_id = $5',
      [presupuesto_enviado ? true : false, pago_realizado ? true : false, envio_realizado ? true : false, parseInt(req.params.id), req.tenantId]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== PRODUCTS API ====================

// Get all products for tenant
app.get('/api/products', authenticateToken, requireActiveTenant, async (req, res) => {
  try {
    const products = await runQuery('SELECT * FROM products WHERE tenant_id = $1 ORDER BY created_at DESC', [req.tenantId]);
    res.json(products);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get low stock products
app.get('/api/products/low-stock', authenticateToken, requireActiveTenant, async (req, res) => {
  try {
    const products = await runQuery('SELECT * FROM products WHERE tenant_id = $1 AND stock <= min_stock ORDER BY stock ASC', [req.tenantId]);
    res.json(products);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single product
app.get('/api/products/:id', authenticateToken, requireActiveTenant, async (req, res) => {
  try {
    const products = await runQuery('SELECT * FROM products WHERE id = $1 AND tenant_id = $2', [parseInt(req.params.id), req.tenantId]);
    if (products.length === 0) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json(products[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create product
app.post('/api/products', authenticateToken, requireActiveTenant, async (req, res) => {
  try {
    const { name, description, category, size, color, price, cost, stock, min_stock, image_url } = req.body;
    const result = await runInsert(
      'INSERT INTO products (tenant_id, name, description, category, size, color, price, cost, stock, min_stock, image_url) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id',
      [req.tenantId, name, description || null, category || null, size || null, color || null, price, cost || 0, stock || 0, min_stock || 5, image_url || null]
    );
    res.status(201).json({ id: result.lastInsertRowid, name, price, stock });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update product
app.put('/api/products/:id', authenticateToken, requireActiveTenant, async (req, res) => {
  try {
    const { name, description, category, size, color, price, cost, stock, min_stock, image_url } = req.body;
    await runUpdate(
      'UPDATE products SET name = $1, description = $2, category = $3, size = $4, color = $5, price = $6, cost = $7, stock = $8, min_stock = $9, image_url = $10, updated_at = CURRENT_TIMESTAMP WHERE id = $11 AND tenant_id = $12',
      [name, description || null, category || null, size || null, color || null, price, cost || 0, stock || 0, min_stock || 5, image_url || null, parseInt(req.params.id), req.tenantId]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update stock
app.patch('/api/products/:id/stock', authenticateToken, requireActiveTenant, async (req, res) => {
  try {
    const { quantity } = req.body;
    const products = await runQuery('SELECT stock FROM products WHERE id = $1 AND tenant_id = $2', [parseInt(req.params.id), req.tenantId]);
    if (products.length === 0) return res.status(404).json({ error: 'Producto no encontrado' });
    
    const newStock = products[0].stock + quantity;
    if (newStock < 0) return res.status(400).json({ error: 'Stock insuficiente' });
    
    await runUpdate('UPDATE products SET stock = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND tenant_id = $3', [newStock, parseInt(req.params.id), req.tenantId]);
    res.json({ success: true, newStock });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete product
app.delete('/api/products/:id', authenticateToken, requireActiveTenant, async (req, res) => {
  try {
    await runDelete('DELETE FROM products WHERE id = $1 AND tenant_id = $2', [parseInt(req.params.id), req.tenantId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== MESSAGES API ====================

// Get messages for a client
app.get('/api/messages/:clientId', authenticateToken, requireActiveTenant, async (req, res) => {
  try {
    // Verify client belongs to tenant
    const clients = await runQuery('SELECT id FROM clients WHERE id = $1 AND tenant_id = $2', [parseInt(req.params.clientId), req.tenantId]);
    if (clients.length === 0) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }
    
    const messages = await runQuery(
      'SELECT * FROM messages WHERE client_id = $1 AND tenant_id = $2 ORDER BY created_at ASC',
      [parseInt(req.params.clientId), req.tenantId]
    );
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all conversations (latest message per client)
app.get('/api/conversations', authenticateToken, requireActiveTenant, async (req, res) => {
  try {
    const clients = await runQuery(
      "SELECT * FROM clients WHERE tenant_id = $1 AND (whatsapp = 1 OR instagram_active = 1) ORDER BY created_at DESC",
      [req.tenantId]
    );
    
    const conversations = await Promise.all(clients.map(async (client) => {
      const lastMessages = await runQuery(
        'SELECT message_text, created_at FROM messages WHERE client_id = $1 AND tenant_id = $2 ORDER BY created_at DESC LIMIT 1',
        [client.id, req.tenantId]
      );
      
      const unreadCount = await runQuery(
        "SELECT COUNT(*) as count FROM messages WHERE client_id = $1 AND tenant_id = $2 AND direction = 'inbound' AND status = 'sent'",
        [client.id, req.tenantId]
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

// Send message with controls
app.post('/api/messages', authenticateToken, requireActiveTenant, async (req, res) => {
  try {
    const { client_id, platform, message_text, message_type = 'service' } = req.body;
    const normalizedPlatform = String(platform || '').toLowerCase();
    const parsedClientId = parseInt(client_id, 10);

    if (!parsedClientId || !['whatsapp', 'instagram'].includes(normalizedPlatform)) {
      return res.status(400).json({ error: 'Datos de mensaje inválidos' });
    }

    if (!message_text || !String(message_text).trim()) {
      return res.status(400).json({ error: 'El mensaje no puede estar vacío' });
    }

    // Verify client belongs to tenant
    const clients = await runQuery('SELECT * FROM clients WHERE id = $1 AND tenant_id = $2', [parsedClientId, req.tenantId]);
    if (clients.length === 0) return res.status(404).json({ error: 'Cliente no encontrado' });

    const client = clients[0];
    
    // Check message limits and 24-hour window
    await canSendMessage(req.tenantId, parsedClientId, message_type);

    let providerResponse;

    if (normalizedPlatform === 'whatsapp') {
      providerResponse = await sendWhatsAppMessage(req.tenantId, client, String(message_text).trim());
    } else {
      providerResponse = await sendInstagramMessage(req.tenantId, client, String(message_text).trim());
    }

    const providerMessageId =
      providerResponse?.messages?.[0]?.id ||
      providerResponse?.message_id ||
      providerResponse?.id ||
      null;

    const insertResult = await runInsert(
      'INSERT INTO messages (tenant_id, client_id, platform, message_text, direction, status, message_id, message_type) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
      [req.tenantId, parsedClientId, normalizedPlatform, String(message_text).trim(), 'outbound', 'sent', providerMessageId, message_type]
    );

    // Update client last_message_at
    await runUpdate('UPDATE clients SET last_message_at = CURRENT_TIMESTAMP WHERE id = $1', [parsedClientId]);
    
    // Increment message count
    await incrementMessageCount(req.tenantId);

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

// Mark messages as read
app.put('/api/messages/read/:clientId', authenticateToken, requireActiveTenant, async (req, res) => {
  try {
    await runUpdate(
      "UPDATE messages SET status = 'read' WHERE client_id = $1 AND tenant_id = $2 AND direction = 'inbound'",
      [parseInt(req.params.clientId), req.tenantId]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get message stats for tenant
app.get('/api/messages/stats', authenticateToken, requireActiveTenant, async (req, res) => {
  try {
    const tenants = await runQuery('SELECT messages_sent_today, messages_sent_monthly, message_limit_monthly, last_message_reset FROM tenants WHERE id = $1', [req.tenantId]);
    
    if (tenants.length === 0) {
      return res.status(404).json({ error: 'Tenant no encontrado' });
    }
    
    const tenant = tenants[0];
    const config = await getTenantConfig(req.tenantId);
    
    res.json({
      messages_sent_today: tenant.messages_sent_today,
      messages_sent_monthly: tenant.messages_sent_monthly,
      message_limit_monthly: tenant.message_limit_monthly || 0,
      max_messages_per_day: config?.max_messages_per_day || 100,
      max_messages_per_month: config?.max_messages_per_month || 1000,
      allow_marketing_messages: config?.allow_marketing_messages || false,
      last_reset: tenant.last_message_reset
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== SALES API ====================

// Get all sales for tenant
app.get('/api/sales', authenticateToken, requireActiveTenant, async (req, res) => {
  try {
    const sales = await runQuery(`
      SELECT s.*, c.name as client_name
      FROM sales s
      LEFT JOIN clients c ON s.client_id = c.id
      WHERE s.tenant_id = $1
      ORDER BY s.created_at DESC
    `, [req.tenantId]);
    res.json(sales);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single sale with items
app.get('/api/sales/:id', authenticateToken, requireActiveTenant, async (req, res) => {
  try {
    const sales = await runQuery(`
      SELECT s.*, c.name as client_name, c.phone as client_phone
      FROM sales s
      LEFT JOIN clients c ON s.client_id = c.id
      WHERE s.id = $1 AND s.tenant_id = $2
    `, [parseInt(req.params.id), req.tenantId]);
    
    if (sales.length === 0) return res.status(404).json({ error: 'Venta no encontrada' });
    
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
app.post('/api/sales', authenticateToken, requireActiveTenant, async (req, res) => {
  try {
    const { client_id, items, payment_method, notes } = req.body;
    
    let total = 0;
    for (const item of items) {
      total += item.unit_price * item.quantity;
    }
    
    const saleResult = await runInsert(
      'INSERT INTO sales (tenant_id, client_id, total, payment_method, status, payment_status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [req.tenantId, client_id || null, total, payment_method || 'cash', 'completed', 'paid']
    );
    const saleId = saleResult.lastInsertRowid;
    
    for (const item of items) {
      const subtotal = item.unit_price * item.quantity;
      await runInsert(
        'INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, subtotal) VALUES ($1, $2, $3, $4, $5)',
        [saleId, item.product_id, item.quantity, item.unit_price, subtotal]
      );
      
      await runUpdate('UPDATE products SET stock = stock - $1 WHERE id = $2 AND tenant_id = $3', [item.quantity, item.product_id, req.tenantId]);
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
app.put('/api/sales/:id/status', authenticateToken, requireActiveTenant, async (req, res) => {
  try {
    const { status, payment_status } = req.body;
    await runUpdate(
      'UPDATE sales SET status = $1, payment_status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 AND tenant_id = $4',
      [status, payment_status || null, parseInt(req.params.id), req.tenantId]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cancel sale (restore stock)
app.delete('/api/sales/:id', authenticateToken, requireActiveTenant, async (req, res) => {
  try {
    const sales = await runQuery('SELECT * FROM sales WHERE id = $1 AND tenant_id = $2', [parseInt(req.params.id), req.tenantId]);
    if (sales.length === 0) return res.status(404).json({ error: 'Venta no encontrada' });
    
    const sale = sales[0];
    
    const items = await runQuery('SELECT * FROM sale_items WHERE sale_id = $1', [sale.id]);
    for (const item of items) {
      await runUpdate('UPDATE products SET stock = stock + $1 WHERE id = $2 AND tenant_id = $3', [item.quantity, item.product_id, req.tenantId]);
    }
    
    await runUpdate('UPDATE sales SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND tenant_id = $3', ['cancelled', parseInt(req.params.id), req.tenantId]);
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== PAYMENTS API ====================

// Get payments for a sale
app.get('/api/payments/:saleId', authenticateToken, requireActiveTenant, async (req, res) => {
  try {
    const payments = await runQuery(
      'SELECT p.* FROM payments p JOIN sales s ON p.sale_id = s.id WHERE p.sale_id = $1 AND s.tenant_id = $2 ORDER BY p.created_at DESC',
      [parseInt(req.params.saleId), req.tenantId]
    );
    res.json(payments);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all payments
app.get('/api/payments', authenticateToken, requireActiveTenant, async (req, res) => {
  try {
    const payments = await runQuery(`
      SELECT p.*, s.id as sale_id, s.total as sale_total
      FROM payments p
      JOIN sales s ON p.sale_id = s.id
      WHERE s.tenant_id = $1
      ORDER BY p.created_at DESC
    `, [req.tenantId]);
    res.json(payments);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create payment
app.post('/api/payments', authenticateToken, requireActiveTenant, async (req, res) => {
  try {
    const { sale_id, amount, payment_method, transaction_id } = req.body;
    
    const result = await runInsert(
      'INSERT INTO payments (sale_id, amount, payment_method, status, transaction_id, payment_date) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP) RETURNING id',
      [parseInt(sale_id), amount, payment_method, 'completed', transaction_id || null]
    );
    
    await runUpdate(
      'UPDATE sales SET payment_status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND tenant_id = $3',
      ['completed', parseInt(sale_id), req.tenantId]
    );
    
    res.status(201).json({ id: result.lastInsertRowid, sale_id: parseInt(sale_id), amount, payment_method, status: 'completed' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== STATS API ====================

// Get dashboard stats for tenant
app.get('/api/stats', authenticateToken, requireActiveTenant, async (req, res) => {
  try {
    const totalClients = await runQuery('SELECT COUNT(*) as count FROM clients WHERE tenant_id = $1', [req.tenantId]);
    const totalProducts = await runQuery('SELECT COUNT(*) as count FROM products WHERE tenant_id = $1', [req.tenantId]);
    const lowStockProducts = await runQuery('SELECT COUNT(*) as count FROM products WHERE tenant_id = $1 AND stock <= min_stock', [req.tenantId]);
    const totalSales = await runQuery("SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as total FROM sales WHERE tenant_id = $1 AND status = 'completed'", [req.tenantId]);
    const totalPayments = await runQuery("SELECT COALESCE(SUM(p.amount), 0) as total FROM payments p JOIN sales s ON p.sale_id = s.id WHERE s.tenant_id = $1 AND p.status = 'completed'", [req.tenantId]);
    
    const salesByMonth = await runQuery(`
      SELECT DATE_TRUNC('month', created_at) as month, SUM(total) as total
      FROM sales
      WHERE tenant_id = $1 AND status = 'completed' AND created_at >= DATE_TRUNC('month', NOW() - INTERVAL '6 months')
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY month
    `, [req.tenantId]);
    
    // Get message stats
    const messageStats = await runQuery('SELECT messages_sent_today, messages_sent_monthly FROM tenants WHERE id = $1', [req.tenantId]);
    
    res.json({
      totalClients: parseInt(totalClients[0]?.count || 0),
      totalProducts: parseInt(totalProducts[0]?.count || 0),
      lowStockProducts: parseInt(lowStockProducts[0]?.count || 0),
      totalSales: parseInt(totalSales[0]?.count || 0),
      totalSalesAmount: parseFloat(totalSales[0]?.total || 0),
      totalPayments: parseFloat(totalPayments[0]?.total || 0),
      salesByMonth,
      messagesSentToday: messageStats[0]?.messages_sent_today || 0,
      messagesSentMonth: messageStats[0]?.messages_sent_monthly || 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== WEBHOOKS (Dynamic based on tenant) ====================

// Get tenant-specific webhook tokens
async function getTenantWebhookTokens(phoneOrAccountId) {
  // Find tenant by WhatsApp phone ID or Instagram business account ID
  const configs = await runQuery(`
    SELECT tc.*, t.id as tenant_id, t.status
    FROM tenant_configs tc
    JOIN tenants t ON tc.tenant_id = t.id
    WHERE t.status = 'active'
  `);
  
  for (const config of configs) {
    if (config.whatsapp_enabled && config.whatsapp_phone_id === phoneOrAccountId) {
      return { tenantId: config.tenant_id, type: 'whatsapp', verifyToken: config.whatsapp_webhook_verify_token };
    }
    if (config.instagram_enabled && config.instagram_business_account_id === phoneOrAccountId) {
      return { tenantId: config.tenant_id, type: 'instagram', verifyToken: config.instagram_webhook_verify_token };
    }
  }
  
  // Return default tokens if no tenant-specific config
  if (DEFAULT_WHATSAPP_TOKEN && DEFAULT_WHATSAPP_PHONE_ID === phoneOrAccountId) {
    return { tenantId: null, type: 'whatsapp', verifyToken: DEFAULT_WHATSAPP_WEBHOOK_VERIFY_TOKEN, isDefault: true };
  }
  
  return null;
}

// Dynamic webhook verification
app.get('/api/webhooks/:platform', async (req, res) => {
  const { platform } = req.params;
  const verifyToken = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  
  // Check tenant-specific first
  let tenantWebhookInfo = null;
  
  if (platform === 'whatsapp' && req.query['phone_id']) {
    tenantWebhookInfo = await getTenantWebhookTokens(req.query['phone_id']);
  } else if (platform === 'instagram' && req.query['account_id']) {
    tenantWebhookInfo = await getTenantWebhookTokens(req.query['account_id']);
  }
  
  const expectedToken = tenantWebhookInfo?.verifyToken || 
    (platform === 'whatsapp' ? DEFAULT_WHATSAPP_WEBHOOK_VERIFY_TOKEN : DEFAULT_INSTAGRAM_WEBHOOK_VERIFY_TOKEN);
  
  if (verifyToken === expectedToken) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Unified webhook endpoint
app.post('/api/webhooks/:platform', async (req, res) => {
  const { platform } = req.params;
  
  try {
    // For WhatsApp - try to determine tenant from phone_id
    if (platform === 'whatsapp') {
      const phoneId = req.body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
      
      if (phoneId) {
        const webhookInfo = await getTenantWebhookTokens(phoneId);
        
        if (webhookInfo && webhookInfo.tenantId) {
          // Process with tenant-specific credentials
          return processWhatsAppWebhook(webhookInfo.tenantId, req, res);
        }
      }
      
      // Fall back to default
      if (DEFAULT_WHATSAPP_TOKEN && DEFAULT_WHATSAPP_PHONE_ID) {
        return processWhatsAppWebhook(null, req, res);
      }
    }
    
    // For Instagram - try to determine tenant from Instagram account
    if (platform === 'instagram') {
      const igUserId = req.body?.entry?.[0]?.messaging?.[0]?.sender?.id;
      
      if (igUserId) {
        // Find tenant by Instagram business account
        const configs = await runQuery(`
          SELECT tc.*, t.id as tenant_id
          FROM tenant_configs tc
          JOIN tenants t ON tc.tenant_id = t.id
          WHERE t.status = 'active' AND tc.instagram_enabled = true
          AND tc.instagram_business_account_id = $1
        `, [igUserId]);
        
        if (configs.length > 0) {
          return processInstagramWebhook(configs[0].tenant_id, req, res);
        }
      }
      
      // Fall back to default
      if (DEFAULT_INSTAGRAM_ACCESS_TOKEN && DEFAULT_INSTAGRAM_BUSINESS_ACCOUNT_ID) {
        return processInstagramWebhook(null, req, res);
      }
    }
    
    res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    console.error(`${platform} webhook error:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

async function processWhatsAppWebhook(tenantId, req, res) {
  try {
    const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];
    const effectiveTenantId = tenantId || 0; // Use 0 for default/system

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
          
          // Extract expiration timestamp from WhatsApp (when the 24h window expires)
          // WhatsApp provides this in the message metadata
          const messageExpiration = incoming?.expiration || null;
          
          // Calculate expiration from timestamp if provided, or use default 24h
          let expirationTimestamp = null;
          if (messageExpiration) {
            expirationTimestamp = new Date(messageExpiration * 1000).toISOString();
          } else {
            // Default: 24 hours from now
            const expiresAt = new Date();
            expiresAt.setHours(expiresAt.getHours() + 24);
            expirationTimestamp = expiresAt.toISOString();
          }

          let client;
          if (tenantId) {
            client = await findOrCreateWhatsappClient(tenantId, from, profileName);
          } else {
            // Default/system client
            client = await findOrCreateWhatsappClient(0, from, profileName);
          }

          const alreadyStored = messageId
            ? await runQuery('SELECT id FROM messages WHERE message_id = $1 LIMIT 1', [messageId])
            : [];
          if (alreadyStored.length > 0) continue;

          await runInsert(
            'INSERT INTO messages (tenant_id, client_id, platform, message_text, direction, status, message_id, message_expiration, service_message_allowed) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id',
            [effectiveTenantId, client.id, 'whatsapp', messageText, 'inbound', 'sent', messageId, expirationTimestamp, true]
          );
        }
      }
    }

    res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    console.error('WhatsApp webhook processing error:', error.message);
    res.status(500).json({ error: error.message });
  }
}

async function processInstagramWebhook(tenantId, req, res) {
  try {
    const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];
    const effectiveTenantId = tenantId || 0;
    
    // Get token for this tenant
    const token = tenantId ? 
      (await getTenantInstagramCredentials(tenantId))?.token : 
      DEFAULT_INSTAGRAM_ACCESS_TOKEN;

    for (const entry of entries) {
      const messaging = Array.isArray(entry?.messaging) ? entry.messaging : [];

      for (const event of messaging) {
        const senderId = event?.sender?.id ? String(event.sender.id) : null;
        const messageText = event?.message?.text ? normalizeIncomingText(event.message.text) : null;
        const messageId = event?.message?.mid || event?.message?.id || null;

        if (!senderId || !messageText) continue;
        
        const businessAccountId = tenantId ?
          (await getTenantInstagramCredentials(tenantId))?.businessAccountId :
          DEFAULT_INSTAGRAM_BUSINESS_ACCOUNT_ID;
          
        if (businessAccountId && senderId === businessAccountId) continue;

        let client;
        if (tenantId) {
          client = await findOrCreateInstagramClient(tenantId, senderId, token);
        } else {
          client = await findOrCreateInstagramClient(0, senderId, token);
        }

        const alreadyStored = messageId
          ? await runQuery('SELECT id FROM messages WHERE message_id = $1 LIMIT 1', [messageId])
          : [];
        if (alreadyStored.length > 0) continue;

        await runInsert(
          'INSERT INTO messages (tenant_id, client_id, platform, message_text, direction, status, message_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
          [effectiveTenantId, client.id, 'instagram', messageText, 'inbound', 'sent', messageId]
        );
      }
    }

    res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    console.error('Instagram webhook processing error:', error.message);
    res.status(500).json({ error: error.message });
  }
}

// Legacy webhook routes for backwards compatibility
app.get('/api/webhooks/whatsapp', (req, res) => {
  const challenge = req.query['hub.challenge'];
  const token = req.query['hub.verify_token'];
  if (token === DEFAULT_WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.get('/api/webhooks/instagram', (req, res) => {
  const challenge = req.query['hub.challenge'];
  const token = req.query['hub.verify_token'];
  if (token === DEFAULT_INSTAGRAM_WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Legacy webhook POST handlers (using default config)
app.post('/api/webhooks/whatsapp', async (req, res) => {
  if (!DEFAULT_WHATSAPP_TOKEN) {
    return res.status(503).json({ error: 'WhatsApp not configured' });
  }
  return processWhatsAppWebhook(null, req, res);
});

app.post('/api/webhooks/instagram', async (req, res) => {
  if (!DEFAULT_INSTAGRAM_ACCESS_TOKEN) {
    return res.status(503).json({ error: 'Instagram not configured' });
  }
  return processInstagramWebhook(null, req, res);
});

// ==================== START SERVER ====================

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

startServer();
