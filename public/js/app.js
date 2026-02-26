// CRM Frontend Application

const API_BASE = '';

// State
let currentSection = 'dashboard';
let currentClientId = null;
let saleCart = [];
let currentSortBy = 'last_message_at';

// Conversation status labels
const statusLabels = {
    'nuevo': '🆕 Nuevo',
    'en_proceso': '💬 En proceso',
    'contestado': '✅ Contestado',
    'esperando_pago': '💳 Esperando pago',
    'pagado': '💰 Pagado',
    'completado': '📦 Completado',
    'cancelado': '❌ Cancelado'
};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    initNavigation();
    loadDashboard();
    loadClients();
    loadProducts();
    loadSales();
    loadPayments();
    loadConversations();
});

// Navigation
function initNavigation() {
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const section = item.dataset.section;
            switchSection(section);
        });
    });
}

function switchSection(section) {
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
        if (item.dataset.section === section) {
            item.classList.add('active');
        }
    });
    
    document.querySelectorAll('.section').forEach(sec => {
        sec.classList.remove('active');
    });
    document.getElementById(section).classList.add('active');
    
    currentSection = section;
    
    // Load data for section
    if (section === 'dashboard') loadDashboard();
    if (section === 'messages') loadConversations();
    if (section === 'clients') loadClients();
    if (section === 'products') loadProducts();
    if (section === 'sales') loadSales();
    if (section === 'payments') loadPayments();
}

// Dashboard
async function loadDashboard() {
    try {
        const response = await fetch(`${API_BASE}/api/dashboard/stats`);
        const stats = await response.json();
        
        document.getElementById('stat-clients').textContent = stats.totalClients;
        document.getElementById('stat-products').textContent = stats.totalProducts;
        document.getElementById('stat-low-stock').textContent = stats.lowStockProducts;
        document.getElementById('stat-today-sales').textContent = `$${parseFloat(stats.todayRevenue).toFixed(2)}`;
        document.getElementById('stat-month-sales').textContent = stats.monthSales;
        document.getElementById('stat-pending').textContent = `$${parseFloat(stats.pendingAmount).toFixed(2)}`;
    } catch (error) {
        console.error('Error loading dashboard:', error);
    }
}

// Clients
async function loadClients() {
    try {
        const response = await fetch(`${API_BASE}/api/clients`);
        const clients = await response.json();
        
        const tbody = document.getElementById('clients-table');
        tbody.innerHTML = clients.map(client => `
            <tr>
                <td>${client.name}</td>
                <td>${client.phone || '-'}</td>
                <td>${client.email || '-'}</td>
                <td>${client.instagram || '-'}</td>
                <td>${client.whatsapp ? '<span class="status-badge completed">Activo</span>' : '<span class="status-badge pending">Inactivo</span>'}</td>
                <td class="actions">
                    <button class="btn-icon" onclick="editClient(${client.id})"><i class="fas fa-edit"></i></button>
                    <button class="btn-icon" onclick="deleteClient(${client.id})"><i class="fas fa-trash"></i></button>
                </td>
            </tr>
        `).join('');
    } catch (error) {
        console.error('Error loading clients:', error);
    }
}

function openClientForm() {
    document.getElementById('client-modal-title').textContent = 'Nuevo Cliente';
    document.getElementById('client-form').reset();
    document.getElementById('client-id').value = '';
    document.getElementById('client-modal').classList.add('active');
}

async function editClient(id) {
    try {
        const response = await fetch(`${API_BASE}/api/clients/${id}`);
        const client = await response.json();
        
        document.getElementById('client-modal-title').textContent = 'Editar Cliente';
        document.getElementById('client-id').value = client.id;
        document.getElementById('client-name').value = client.name;
        document.getElementById('client-phone').value = client.phone || '';
        document.getElementById('client-email').value = client.email || '';
        document.getElementById('client-instagram').value = client.instagram || '';
        document.getElementById('client-whatsapp').checked = client.whatsapp === 1;
        document.getElementById('client-instagram-active').checked = client.instagram_active === 1;
        
        document.getElementById('client-modal').classList.add('active');
    } catch (error) {
        console.error('Error loading client:', error);
    }
}

async function saveClient(e) {
    e.preventDefault();
    
    const id = document.getElementById('client-id').value;
    const data = {
        name: document.getElementById('client-name').value,
        phone: document.getElementById('client-phone').value,
        email: document.getElementById('client-email').value,
        instagram: document.getElementById('client-instagram').value,
        whatsapp: document.getElementById('client-whatsapp').checked,
        instagram_active: document.getElementById('client-instagram-active').checked
    };
    
    try {
        const url = id ? `${API_BASE}/api/clients/${id}` : `${API_BASE}/api/clients`;
        const method = id ? 'PUT' : 'POST';
        
        await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        
        closeModal('client-modal');
        loadClients();
        loadConversations();
    } catch (error) {
        console.error('Error saving client:', error);
    }
}

async function deleteClient(id) {
    if (!confirm('¿Estás seguro de eliminar este cliente?')) return;
    
    try {
        await fetch(`${API_BASE}/api/clients/${id}`, { method: 'DELETE' });
        loadClients();
        loadConversations();
    } catch (error) {
        console.error('Error deleting client:', error);
    }
}

// Products
async function loadProducts() {
    try {
        const response = await fetch(`${API_BASE}/api/products`);
        const products = await response.json();
        
        const grid = document.getElementById('products-grid');
        grid.innerHTML = products.map(product => `
            <div class="product-card">
                <div class="image">
                    ${product.image_url ? 
                        `<img src="${product.image_url}" alt="${product.name}">` : 
                        '<i class="fas fa-box fa-3x"></i>'}
                </div>
                <div class="info">
                    <div class="name">${product.name}</div>
                    <div class="category">${product.category || 'Sin categoría'} | ${product.size || '-'} | ${product.color || '-'}</div>
                    <div class="details">
                        <span>Costo: $${parseFloat(product.cost).toFixed(2)}</span>
                    </div>
                    <div class="price">$${parseFloat(product.price).toFixed(2)}</div>
                    <div class="stock ${product.stock <= product.min_stock ? 'low' : ''}">
                        Stock: ${product.stock} (mín: ${product.min_stock})
                    </div>
                </div>
                <div class="actions">
                    <button class="btn-secondary" onclick="editProduct(${product.id})">Editar</button>
                    <button class="btn-danger" onclick="deleteProduct(${product.id})">Eliminar</button>
                </div>
            </div>
        `).join('');
    } catch (error) {
        console.error('Error loading products:', error);
    }
}

function openProductForm() {
    document.getElementById('product-modal-title').textContent = 'Nuevo Producto';
    document.getElementById('product-form').reset();
    document.getElementById('product-id').value = '';
    document.getElementById('product-modal').classList.add('active');
}

async function editProduct(id) {
    try {
        const response = await fetch(`${API_BASE}/api/products/${id}`);
        const product = await response.json();
        
        document.getElementById('product-modal-title').textContent = 'Editar Producto';
        document.getElementById('product-id').value = product.id;
        document.getElementById('product-name').value = product.name;
        document.getElementById('product-description').value = product.description || '';
        document.getElementById('product-category').value = product.category || '';
        document.getElementById('product-size').value = product.size || '';
        document.getElementById('product-color').value = product.color || '';
        document.getElementById('product-price').value = product.price;
        document.getElementById('product-cost').value = product.cost || 0;
        document.getElementById('product-stock').value = product.stock;
        document.getElementById('product-min-stock').value = product.min_stock;
        document.getElementById('product-image').value = product.image_url || '';
        
        document.getElementById('product-modal').classList.add('active');
    } catch (error) {
        console.error('Error loading product:', error);
    }
}

async function saveProduct(e) {
    e.preventDefault();
    
    const id = document.getElementById('product-id').value;
    const data = {
        name: document.getElementById('product-name').value,
        description: document.getElementById('product-description').value,
        category: document.getElementById('product-category').value,
        size: document.getElementById('product-size').value,
        color: document.getElementById('product-color').value,
        price: parseFloat(document.getElementById('product-price').value),
        cost: parseFloat(document.getElementById('product-cost').value) || 0,
        stock: parseInt(document.getElementById('product-stock').value) || 0,
        min_stock: parseInt(document.getElementById('product-min-stock').value) || 5,
        image_url: document.getElementById('product-image').value
    };
    
    try {
        const url = id ? `${API_BASE}/api/products/${id}` : `${API_BASE}/api/products`;
        const method = id ? 'PUT' : 'POST';
        
        await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        
        closeModal('product-modal');
        loadProducts();
    } catch (error) {
        console.error('Error saving product:', error);
    }
}

async function deleteProduct(id) {
    if (!confirm('¿Estás seguro de eliminar este producto?')) return;
    
    try {
        await fetch(`${API_BASE}/api/products/${id}`, { method: 'DELETE' });
        loadProducts();
    } catch (error) {
        console.error('Error deleting product:', error);
    }
}

// Sales
async function loadSales() {
    try {
        const response = await fetch(`${API_BASE}/api/sales`);
        const sales = await response.json();
        
        const tbody = document.getElementById('sales-table');
        const paymentMethods = {
            'cash': 'Efectivo',
            'transfer': 'Transferencia',
            'card': 'Tarjeta',
            'mercadopago': 'MercadoPago'
        };
        
        tbody.innerHTML = sales.map(sale => `
            <tr>
                <td>#${sale.id}</td>
                <td>${sale.client_name || 'Sin cliente'}</td>
                <td>$${parseFloat(sale.total).toFixed(2)}</td>
                <td>${paymentMethods[sale.payment_method] || '-'}</td>
                <td><span class="status-badge ${sale.status}">${sale.status === 'completed' ? 'Completada' : sale.status}</span></td>
                <td>${new Date(sale.created_at).toLocaleDateString()}</td>
                <td class="actions">
                    <button class="btn-icon" onclick="viewSale(${sale.id})"><i class="fas fa-eye"></i></button>
                    ${sale.status === 'completed' ? `<button class="btn-danger" onclick="cancelSale(${sale.id})">Cancelar</button>` : ''}
                </td>
            </tr>
        `).join('');
    } catch (error) {
        console.error('Error loading sales:', error);
    }
}

async function openSaleModal() {
    saleCart = [];
    document.getElementById('sale-form').reset();
    
    // Load clients
    const clientsResponse = await fetch(`${API_BASE}/api/clients`);
    const clients = await clientsResponse.json();
    document.getElementById('sale-client').innerHTML = `
        <option value="">Sin cliente</option>
        ${clients.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
    `;
    
    // Load products
    const productsResponse = await fetch(`${API_BASE}/api/products`);
    const products = await productsResponse.json();
    
    document.getElementById('sale-products').innerHTML = products.map(p => `
        <div class="sale-product-item">
            <div class="info">
                <div class="name">${p.name} - ${p.size || ''} ${p.color || ''}</div>
                <div class="price">$${parseFloat(p.price).toFixed(2)}</div>
                <div class="stock">Stock: ${p.stock}</div>
            </div>
            <button class="add-btn" onclick="addToCart(${p.id}, '${p.name.replace(/'/g, "\\'")}', ${p.price}, ${p.stock})">Agregar</button>
        </div>
    `).join('');
    
    updateSaleCart();
    document.getElementById('sale-modal').classList.add('active');
}

function addToCart(id, name, price, stock) {
    const existing = saleCart.find(item => item.product_id === id);
    if (existing) {
        if (existing.quantity < stock) {
            existing.quantity++;
        } else {
            alert('Stock insuficiente');
        }
    } else {
        if (stock > 0) {
            saleCart.push({ product_id: id, name, unit_price: price, quantity: 1, max_stock: stock });
        } else {
            alert('Producto sin stock');
            return;
        }
    }
    updateSaleCart();
}

function updateSaleCart() {
    const container = document.getElementById('sale-items');
    
    if (saleCart.length === 0) {
        container.innerHTML = '<p style="text-align:center;color:var(--secondary)">Agrega productos a la venta</p>';
    } else {
        container.innerHTML = saleCart.map((item, index) => `
            <div class="sale-item">
                <div class="info">
                    <strong>${item.name}</strong>
                    <div>$${parseFloat(item.unit_price).toFixed(2)} x ${item.quantity}</div>
                </div>
                <div class="quantity-controls">
                    <button onclick="updateQuantity(${index}, -1)">-</button>
                    <span>${item.quantity}</span>
                    <button onclick="updateQuantity(${index}, 1)">+</button>
                </div>
            </div>
        `).join('');
    }
    
    const total = saleCart.reduce((sum, item) => sum + (item.unit_price * item.quantity), 0);
    document.getElementById('sale-total').textContent = total.toFixed(2);
}

function updateQuantity(index, delta) {
    saleCart[index].quantity += delta;
    if (saleCart[index].quantity <= 0) {
        saleCart.splice(index, 1);
    } else if (saleCart[index].quantity > saleCart[index].max_stock) {
        saleCart[index].quantity = saleCart[index].max_stock;
    }
    updateSaleCart();
}

async function saveSale(e) {
    e.preventDefault();
    
    if (saleCart.length === 0) {
        alert('Agrega al menos un producto');
        return;
    }
    
    const data = {
        client_id: document.getElementById('sale-client').value || null,
        items: saleCart,
        payment_method: document.getElementById('sale-payment-method').value,
        notes: document.getElementById('sale-notes').value
    };
    
    try {
        await fetch(`${API_BASE}/api/sales`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        
        closeModal('sale-modal');
        loadSales();
        loadProducts();
        loadDashboard();
    } catch (error) {
        console.error('Error saving sale:', error);
    }
}

async function viewSale(id) {
    try {
        const response = await fetch(`${API_BASE}/api/sales/${id}`);
        const sale = await response.json();
        
        const paymentMethods = {
            'cash': 'Efectivo',
            'transfer': 'Transferencia',
            'card': 'Tarjeta',
            'mercadopago': 'MercadoPago'
        };
        
        document.getElementById('view-sale-id').textContent = sale.id;
        document.getElementById('view-sale-details').innerHTML = `
            <div class="view-sale-info">
                <div class="row">
                    <span class="label">Cliente</span>
                    <span class="value">${sale.client_name || 'Sin cliente'}</span>
                </div>
                <div class="row">
                    <span class="label">Teléfono</span>
                    <span class="value">${sale.client_phone || '-'}</span>
                </div>
                <div class="row">
                    <span class="label">Método de Pago</span>
                    <span class="value">${paymentMethods[sale.payment_method] || '-'}</span>
                </div>
                <div class="row">
                    <span class="label">Estado</span>
                    <span class="value">${sale.status === 'completed' ? 'Completada' : sale.status}</span>
                </div>
                <div class="row">
                    <span class="label">Fecha</span>
                    <span class="value">${new Date(sale.created_at).toLocaleString()}</span>
                </div>
                <div class="row">
                    <span class="label">Notas</span>
                    <span class="value">${sale.notes || '-'}</span>
                </div>
            </div>
            <div class="view-sale-items">
                <h4>Productos</h4>
                ${sale.items.map(item => `
                    <div class="view-sale-item">
                        <span>${item.product_name} (${item.size || ''} ${item.color || ''}) x${item.quantity}</span>
                        <span>$${parseFloat(item.subtotal).toFixed(2)}</span>
                    </div>
                `).join('')}
                <div class="view-sale-item" style="border-top: 2px solid var(--border); margin-top: 12px; padding-top: 12px;">
                    <strong>Total</strong>
                    <strong>$${parseFloat(sale.total).toFixed(2)}</strong>
                </div>
            </div>
        `;
        
        document.getElementById('view-sale-modal').classList.add('active');
    } catch (error) {
        console.error('Error loading sale:', error);
    }
}

async function cancelSale(id) {
    if (!confirm('¿Estás seguro de cancelar esta venta? El stock será restaurado.')) return;
    
    try {
        await fetch(`${API_BASE}/api/sales/${id}`, { method: 'DELETE' });
        loadSales();
        loadProducts();
        loadDashboard();
    } catch (error) {
        console.error('Error canceling sale:', error);
    }
}

// Payments
async function loadPayments() {
    try {
        const response = await fetch(`${API_BASE}/api/payments`);
        const payments = await response.json();
        
        const tbody = document.getElementById('payments-table');
        const paymentMethods = {
            'cash': 'Efectivo',
            'transfer': 'Transferencia',
            'card': 'Tarjeta',
            'mercadopago': 'MercadoPago'
        };
        
        tbody.innerHTML = payments.map(payment => `
            <tr>
                <td>#${payment.id}</td>
                <td>#${payment.sale_id}</td>
                <td>$${parseFloat(payment.amount).toFixed(2)}</td>
                <td>${paymentMethods[payment.payment_method]}</td>
                <td><span class="status-badge ${payment.status}">${payment.status === 'completed' ? 'Pagado' : payment.status}</span></td>
                <td>${new Date(payment.created_at).toLocaleDateString()}</td>
            </tr>
        `).join('');
    } catch (error) {
        console.error('Error loading payments:', error);
    }
}

// Messages / Conversations

async function loadConversations() {
    try {
        // Check and update stale conversations first (7+ days)
        await fetch(`${API_BASE}/api/clients/check-stale`, { method: 'POST' });
        
        const response = await fetch(`${API_BASE}/api/conversations`);
        const conversations = await response.json();
        conversationsData = conversations;
        
        const container = document.getElementById('conversations-list');
        
        // Get filter value
        const filterEl = document.getElementById('conversation-filter');
        const filterValue = filterEl ? filterEl.value : 'all';
        
        // Filter conversations
        let filtered = filterValue === 'all' 
            ? conversations 
            : conversations.filter(c => c.conversation_status === filterValue);
        
        // Sort conversations
        filtered = sortConversationsList(filtered);
        
        if (filtered.length === 0) {
            container.innerHTML = '<p style="text-align:center;color:var(--text-secondary);padding:20px">No hay conversaciones</p>';
            return;
        }
        
        // Group by status if sorted by status
        if (currentSortBy === 'status') {
            const grouped = {};
            const statusOrder = ['nuevo', 'esperando_respuesta', 'cotizacion_enviada', 'esperando_pago', 'pago_recibido', 'preparando_pedido', 'enviado', 'entregado', 'completado', 'cancelado'];
            
            filtered.forEach(conv => {
                const status = conv.conversation_status || 'nuevo';
                if (!grouped[status]) grouped[status] = [];
                grouped[status].push(conv);
            });
            
            container.innerHTML = statusOrder.filter(s => grouped[s] && grouped[s].length > 0).map(status => `
                <div class="conversation-group">
                    <div class="group-header">${statusLabels[status]}</div>
                    ${grouped[status].map(conv => `
                        <div class="conversation-item ${currentClientId === conv.id ? 'active' : ''}" 
                             onclick="openConversation(${conv.id}, '${conv.name.replace(/'/g, "\\'")}')">
                            <div class="name">${conv.name}</div>
                            <div class="preview">${conv.last_message || 'Sin mensajes'}</div>
                            <div class="time">${conv.last_message_at ? new Date(conv.last_message_at).toLocaleString() : ''}</div>
                            ${conv.unread_count > 0 ? `<span class="badge" style="display:inline-block;margin-top:4px">${conv.unread_count}</span>` : ''}
                        </div>
                    `).join('')}
                </div>
            `).join('');
        } else {
            // Regular list when sorted by date
            container.innerHTML = filtered.map(conv => `
                <div class="conversation-item ${currentClientId === conv.id ? 'active' : ''}" 
                     onclick="openConversation(${conv.id}, '${conv.name.replace(/'/g, "\\'")}')">
                    <div class="name">${conv.name}</div>
                    <div class="preview">${conv.last_message || 'Sin mensajes'}</div>
                    <div class="time">${conv.last_message_at ? new Date(conv.last_message_at).toLocaleString() : ''}</div>
                    ${conv.unread_count > 0 ? `<span class="badge" style="display:inline-block;margin-top:4px">${conv.unread_count}</span>` : ''}
                    <div class="conversation-status">${statusLabels[conv.conversation_status] || statusLabels['nuevo']}</div>
                </div>
            `).join('');
        }
        
        // Update badge
        const totalUnread = conversations.reduce((sum, c) => sum + (c.unread_count || 0), 0);
        const badge = document.getElementById('unread-badge');
        if (totalUnread > 0) {
            badge.textContent = totalUnread;
            badge.style.display = 'inline-block';
        } else {
            badge.style.display = 'none';
        }
    } catch (error) {
        console.error('Error loading conversations:', error);
    }
}

function filterConversations() {
    loadConversations();
}

function sortConversations() {
    const sortLabel = document.getElementById('sort-label');
    if (currentSortBy === 'last_message_at') {
        currentSortBy = 'status';
        if (sortLabel) sortLabel.textContent = 'Estado';
    } else {
        currentSortBy = 'last_message_at';
        if (sortLabel) sortLabel.textContent = 'Última actualización';
    }
    loadConversations();
}

function sortConversationsList(conversations) {
    if (currentSortBy === 'status') {
        const priority = {
            'nuevo': 1, 'en_proceso': 2, 'contestado': 3,
            'esperando_pago': 4, 'pagado': 5, 'completado': 6, 'cancelado': 7
        };
        return conversations.sort((a, b) => (priority[a.conversation_status] || 99) - (priority[b.conversation_status] || 99));
    } else {
        return conversations.sort((a, b) => {
            if (!a.last_message_at) return 1;
            if (!b.last_message_at) return -1;
            return new Date(b.last_message_at) - new Date(a.last_message_at);
        });
    }
}

async function openConversation(clientId, clientName) {
    currentClientId = clientId;
    
    // Update UI
    document.querySelectorAll('.conversation-item').forEach(item => {
        item.classList.remove('active');
    });
    event.target.closest('.conversation-item').classList.add('active');
    
    document.getElementById('chat-area').style.display = 'flex';
    document.getElementById('no-chat').style.display = 'none';
    document.getElementById('chat-client-name').textContent = clientName;
    
    // Load client info for platform and status
    try {
        const response = await fetch(`${API_BASE}/api/clients/${clientId}`);
        const client = await response.json();
        
        // Set default platform
        const platformSelect = document.getElementById('message-platform');
        if (client.whatsapp) {
            platformSelect.value = 'whatsapp';
        } else if (client.instagram_active) {
            platformSelect.value = 'instagram';
        }
        
        const platformBadge = document.getElementById('chat-platform');
        platformBadge.className = `platform-badge ${platformSelect.value}`;
        platformBadge.textContent = platformSelect.value === 'whatsapp' ? 'WhatsApp' : 'Instagram';
        
        // Set conversation status
        document.getElementById('conversation-status').value = client.conversation_status || 'novo';
    } catch (error) {
        console.error('Error loading client:', error);
    }
    
    // Load messages
    await loadMessages(clientId);
    
    // Mark as read
    try {
        await fetch(`${API_BASE}/api/messages/read/${clientId}`, { method: 'PUT' });
        loadConversations();
    } catch (error) {
        console.error('Error marking messages as read:', error);
    }
}

async function loadMessages(clientId) {
    try {
        const response = await fetch(`${API_BASE}/api/messages/${clientId}`);
        const messages = await response.json();
        
        const container = document.getElementById('chat-messages');
        
        if (messages.length === 0) {
            container.innerHTML = '<p style="text-align:center;color:var(--secondary)">No hay mensajes</p>';
            return;
        }
        
        container.innerHTML = messages.map(msg => `
            <div class="message ${msg.direction}">
                ${msg.message_text}
                <div class="time">${new Date(msg.created_at).toLocaleString()}</div>
            </div>
        `).join('');
        
        // Scroll to bottom
        container.scrollTop = container.scrollHeight;
    } catch (error) {
        console.error('Error loading messages:', error);
    }
}

async function sendMessage() {
    const text = document.getElementById('message-text').value.trim();
    const platform = document.getElementById('message-platform').value;
    
    if (!text || !currentClientId) return;
    
    try {
        await fetch(`${API_BASE}/api/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: currentClientId,
                platform,
                message_text: text
            })
        });
        
        document.getElementById('message-text').value = '';
        await loadMessages(currentClientId);
        loadConversations();
        
        // AUTOMATION: After sending a message, change status
        const currentStatus = document.getElementById('conversation-status').value;
        
        // If was waiting for response, now it's "contestado"
        if (currentStatus === 'en_proceso') {
            await fetch(`${API_BASE}/api/clients/${currentClientId}/status`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ conversation_status: 'contestado' })
            });
            document.getElementById('conversation-status').value = 'contestado';
        }
        
    } catch (error) {
        console.error('Error sending message:', error);
    }
}

// Send message on Enter
document.getElementById('message-text').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        sendMessage();
    }
});

// Platform change
document.getElementById('message-platform').addEventListener('change', (e) => {
    const platformBadge = document.getElementById('chat-platform');
    platformBadge.className = `platform-badge ${e.target.value}`;
    platformBadge.textContent = e.target.value === 'whatsapp' ? 'WhatsApp' : 'Instagram';
});

// Modal functions
function closeModal(modalId) {
    document.getElementById(modalId).classList.remove('active');
}

// Close modal on outside click
document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.classList.remove('active');
        }
    });
});

function openClientModal() {
    if (currentClientId) {
        editClient(currentClientId);
    }
}

// Conversation Status Functions
async function updateConversationStatus() {
    const status = document.getElementById('conversation-status').value;
    if (!currentClientId) return;
    
    try {
        await fetch(`${API_BASE}/api/clients/${currentClientId}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ conversation_status: status })
        });
        loadConversations();
    } catch (error) {
        console.error('Error updating status:', error);
    }
}

function openSaleFromChat() {
    if (!currentClientId) {
        alert('Selecciona un cliente primero');
        return;
    }
    openSaleModal();
    // Pre-select the client
    document.getElementById('sale-client').value = currentClientId;
}

function openPaymentFromChat() {
    if (!currentClientId) {
        alert('Selecciona un cliente primero');
        return;
    }
    // Get sales for this client
    fetch(`${API_BASE}/api/sales`)
        .then(res => res.json())
        .then(sales => {
            const clientSales = sales.filter(s => s.client_id === currentClientId && s.payment_status !== 'paid');
            if (clientSales.length === 0) {
                alert('No hay ventas pendientes de pago para este cliente');
                return;
            }
            // Open payment modal with sale selection
            openPaymentModal(clientSales);
        });
}

function openPaymentModal(clientSales) {
    let html = `
        <div class="modal-content">
            <div class="modal-header">
                <h2>Registrar Pago</h2>
                <button class="btn-close" onclick="closeModal('payment-modal')">&times;</button>
            </div>
            <form id="payment-form" onsubmit="savePaymentFromChat(event)">
                <div class="form-group">
                    <label>Seleccionar Venta</label>
                    <select id="payment-sale-id" required>
                        ${clientSales.map(s => `<option value="${s.id}">Venta #${s.id} - ${parseFloat(s.total).toFixed(2)}</option>`).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label>Método de Pago</label>
                    <select id="payment-method" required>
                        <option value="cash">Efectivo</option>
                        <option value="transfer">Transferencia</option>
                        <option value="card">Tarjeta</option>
                        <option value="mercadopago">MercadoPago</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Monto</label>
                    <input type="number" step="0.01" id="payment-amount" required>
                </div>
                <div class="form-group">
                    <label>ID de Transacción (opcional)</label>
                    <input type="text" id="payment-transaction">
                </div>
                <button type="submit" class="btn-primary">Registrar Pago</button>
            </form>
        </div>
    `;
    
    // Remove old modal if exists
    const oldModal = document.getElementById('payment-modal');
    if (oldModal) oldModal.remove();
    
    const modal = document.createElement('div');
    modal.id = 'payment-modal';
    modal.className = 'modal active';
    modal.innerHTML = html;
    document.body.appendChild(modal);
    
    // Set default amount from first sale
    const amountInput = document.getElementById('payment-amount');
    if (clientSales.length > 0) {
        amountInput.value = clientSales[0].total;
    }
}

async function savePaymentFromChat(e) {
    e.preventDefault();
    
    const data = {
        sale_id: document.getElementById('payment-sale-id').value,
        amount: parseFloat(document.getElementById('payment-amount').value),
        payment_method: document.getElementById('payment-method').value,
        transaction_id: document.getElementById('payment-transaction').value
    };
    
    try {
        await fetch(`${API_BASE}/api/payments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        
        // Update conversation status to "pago_recibido"
        await fetch(`${API_BASE}/api/clients/${currentClientId}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ conversation_status: 'pago_recibido' })
        });
        
        closeModal('payment-modal');
        loadConversations();
        updateConversationStatusUI('pago_recibido');
        loadDashboard();
        alert('Pago registrado exitosamente');
    } catch (error) {
        console.error('Error saving payment:', error);
    }
}

function updateConversationStatusUI(status) {
    document.getElementById('conversation-status').value = status;
}
