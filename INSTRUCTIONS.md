# Instructivo de Configuración - APIs de WhatsApp e Instagram

## Introducción

El CRM ya tiene la estructura lista para conectar con las APIs de WhatsApp Business e API. A Instagram Graph continuación se detalla cómo configurar cada plataforma.

---

## WhatsApp Business API (Meta/Facebook)

### Paso 1: Crear una cuenta de desarrollador
1. Ve a https://developers.facebook.com/
2. Inicia sesión con tu cuenta de Facebook
3. Crea una nueva aplicación (tipo "Negocios")

### Paso 2: Configurar WhatsApp
1. En tu aplicación, selecciona "Agregar productos" → WhatsApp
2. Completa la verificación de negocio
3. Obtén el **Token de Acceso** (Access Token) temporal
4. Obtén el **Número de Teléfono ID** y **WhatsApp Business Account ID**

### Paso 3: Configurar Webhooks
1. Configura una URL de webhook en tu servidor
2. El endpoint debe ser: `https://tu-dominio.com/api/webhooks/whatsapp`
3. Verifica el webhook con el token proporcionado por Meta

### Paso 4: Actualizar el servidor

En `server.js`,找到发送消息的函数并替换为真实的API调用：

```javascript
// Ejemplo de implementación para WhatsApp
const axios = require('axios');

async function sendWhatsAppMessage(phone, message) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_ID;
  
  const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;
  
  const response = await axios.post(url, {
    messaging_product: 'whatsapp',
    to: phone,
    text: { body: message }
  }, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });
  
  return response.data;
}
```

### Variables de entorno necesarias:

```env
WHATSAPP_TOKEN=tu_token_de_acceso
WHATSAPP_PHONE_ID=tu_phone_number_id
WHATSAPP_BUSINESS_ACCOUNT_ID=tu_business_account_id
WHATSAPP_WEBHOOK_VERIFY_TOKEN=tu_verify_token
```

---

## Instagram Graph API

### Paso 1: Requisitos previos
1. Tener una cuenta de Instagram Business o Creator
2. Tener una página de Facebook vinculada
3. Cuenta de desarrollador de Meta

### Paso 2: Configurar la app
1. Ve a Meta for Developers
2. Agrega el producto "Instagram Graph API"
3. Configura los permisos necesarios:
   - `instagram_basic`
   - `instagram_manage_messages`
   - `instagram_manage_comments`
   - `pages_show_list`
   - `pages_read_engagement`

### Paso 3: Obtener credenciales
1. **Page Access Token**: Para acceder a la página vinculada
2. **Instagram Business Account ID**: ID de tu cuenta de Instagram

### Paso 4: Implementar en el servidor

```javascript
// Ejemplo de implementación para Instagram
const axios = require('axios');

async function sendInstagramMessage(igUserId, message, accessToken) {
  const url = `https://graph.facebook.com/v18.0/${igUserId}/messages`;
  
  const response = await axios.post(url, {
    messaging_product: 'instagram',
    recipient: { id: igUserId },
    message: { text: message }
  }, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });
  
  return response.data;
}
```

### Variables de entorno necesarias:

```env
INSTAGRAM_ACCESS_TOKEN=tu_access_token
INSTAGRAM_BUSINESS_ACCOUNT_ID=tu_instagram_user_id
```

---

## Implementación de Webhooks

### WhatsApp Webhook

```javascript
app.post('/api/webhooks/whatsapp', async (req, res) => {
  const { entry } = req.body;
  
  for (const changes of entry?.[0]?.changes || []) {
    const messages = changes.value?.messages;
    
    if (messages) {
      for (const msg of messages) {
        const phone = msg.from;
        const text = msg.text?.body;
        
        // Guardar mensaje en la base de datos
        // Buscar cliente por teléfono y guardar mensaje
      }
    }
  }
  
  res.send('OK');
});

// Verificación del webhook
app.get('/api/webhooks/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  
  if (mode === 'subscribe' && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    res.send(challenge);
  } else {
    res.sendStatus(403);
  }
});
```

### Instagram Webhook

```javascript
app.post('/api/webhooks/instagram', async (req, res) => {
  const { entry } = req.body;
  
  for (const igEntry of entry || []) {
    const messaging = igEntry.messaging;
    
    if (messaging) {
      for (const msg of messaging) {
        const senderId = msg.sender.id;
        const text = msg.message?.text;
        
        // Guardar mensaje en la base de datos
      }
    }
  }
  
  res.send('OK');
});
```

---

## Estructura de mensajes en la base de datos

El CRM ya guarda los mensajes con esta estructura:

| Campo | Descripción |
|-------|-------------|
| client_id | ID del cliente en la base de datos |
| platform | 'whatsapp' o 'instagram' |
| message_text | Contenido del mensaje |
| direction | 'inbound' (recibido) o 'outbound' (enviado) |
| status | 'sent', 'delivered', 'read', 'failed' |
| message_id | ID del mensaje en la API externa |

---

## Notas importantes

1. **Tokens temporales**: Los tokens de acceso de Meta expiran. Implementa un sistema de renovación automática.

2. **Rate Limits**: Ambas APIs tienen límites de uso. Maneja errores 429 apropiadamente.

3. **Mensajes Templates**: WhatsApp requiere templates pre-aprobados para iniciar conversaciones fuera de la ventana de 24 horas.

4. **Cumplimiento**: Asegúrate de cumplir con las políticas de Meta y las leyes de protección de datos de tu país.

---

## Archivo .env.example

Crea un archivo `.env` en la raíz del proyecto:

```env
# Puerto del servidor
PORT=3000

# WhatsApp
WHATSAPP_TOKEN=your_whatsapp_token
WHATSAPP_PHONE_ID=your_phone_number_id
WHATSAPP_BUSINESS_ACCOUNT_ID=your_business_account_id
WHATSAPP_WEBHOOK_VERIFY_TOKEN=your_verify_token

# Instagram
INSTAGRAM_ACCESS_TOKEN=your_instagram_token
INSTAGRAM_BUSINESS_ACCOUNT_ID=your_instagram_user_id
```

---

## Soporte

Si necesitas ayuda adicional para configurar las APIs, contacta a un desarrollador especializado en integraciones de Meta APIs.
