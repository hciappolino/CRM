const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const { initDb, runQuery, runInsert, runUpdate, runDelete } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize database and start server
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
app.get('/api/clients', async (req, res) => {
  try {
    const clients = await runQuery('SELECT * FROM clients ORDER BY created_at DESC');
    res.json(clients);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single client
app.get('/api/clients/:id', async (req, res) => {
  try {
    const clients = await runQuery('SELECT * FROM clients WHERE id = $1', [parseInt(req.params.id)]);
    if (clients.length === 0) return res.status(404).json({ error: 'Client not found' });
    res.json(clients[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create client
app.post('/api/clients', async (req, res) => {
  try {
    const { name, phone, email, instagram, whatsapp } = req.body;
    const result = await runInsert(
      'INSERT INTO clients (name, phone, email, instagram, whatsapp) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [name, phone || null, email || null, instagram || null, whatsapp ? 1 : 0]
    );
    res.status(201).json({ id: result.lastInsertRowid, name, phone, email, instagram, whatsapp });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update client
app.put('/api/clients/:id', async (req, res) => {
  try {
    const { name, phone, email, instagram, whatsapp, instagram_active } = req.body;
    await runUpdate(
      'UPDATE clients SET name = $1, phone = $2, email = $3, instagram = $4, whatsapp = $5, instagram_active = $6, updated_at = CURRENT_TIMESTAMP WHERE id = $7',
      [name, phone || null, email || null, instagram || null, whatsapp ? 1 : 0, instagram_active ? 1 : 0, parseInt(req.params.id)]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete client
app.delete('/api/clients/:id', async (req, res) => {
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

// Send message (simulated - in production would connect to WhatsApp/Instagram API)
app.post('/api/messages', async (req, res) => {
  try {
    const { client_id, platform, message_text } = req.body;
    
    const result = await runInsert(
      'INSERT INTO messages (client_id, platform, message_text, direction, status) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [parseInt(client_id), platform, message_text, 'outbound', 'sent']
    );
    
    res.status(201).json({ 
      id: result.lastInsertRowid, 
      client_id: parseInt(client_id), 
      platform, 
      message_text, 
      direction: 'outbound',
      status: 'sent'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
app.get('/api/stats', async (req, res) => {
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
