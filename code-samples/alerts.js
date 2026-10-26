const https = require('https');
const config = require('./config');

// ---------------------------------------------------------------------------
// Canais: Telegram (recomendado: gratis, ilimitado, API oficial) e WhatsApp via
// CallMeBot (cota gratuita pequena -- quando acaba, o bot responde "You have 0
// messages left" e para de entregar). Cada alerta vai para TODOS os canais
// configurados; se um falhar, o outro ainda entrega.
// ---------------------------------------------------------------------------

// Anti-spam: o mesmo TIPO de alerta so e reenviado depois de um cooldown que
// CRESCE a cada repeticao seguida (30min, 1h, 2h, 4h ... ate 6h). Se o tipo fica
// 12h sem disparar, volta ao inicio. Antes era 30min fixo -- um VPD critico
// prolongado mandava dezenas de mensagens e estourou a cota do WhatsApp.
const BASE_COOLDOWN_MS = 30 * 60 * 1000;
const MAX_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const RESET_AFTER_MS = 12 * 60 * 60 * 1000;
const FAILURE_RETRY_MS = 10 * 60 * 1000; // se TODOS os canais falharam, tenta de novo em 10min
const state = {}; // type -> { lastSentAt, repeats, retryAt }

// Teto global (protege contra tempestade de alertas de tipos diferentes)
const MAX_PER_HOUR = Number(process.env.ALERT_MAX_PER_HOUR) || 12;
const sentTimes = [];
// O WhatsApp (cota gratis) tem teto proprio por dia; Telegram nao tem
const WHATSAPP_MAX_PER_DAY = Number(process.env.ALERT_WHATSAPP_MAX_PER_DAY) || 6;
const whatsappSent = [];

const status = {
  lastSentAt: null,
  lastError: null,        // ultimo erro de entrega (qualquer canal)
  lastErrorAt: null,
  channels: { telegram: { lastOk: null, lastError: null }, whatsapp: { lastOk: null, lastError: null } }
};

function telegramConfigured() {
  return !!(config.telegram && config.telegram.botToken && config.telegram.chatId);
}
function whatsappConfigured() {
  return !!(config.whatsapp.phone && config.whatsapp.apiKey);
}
function isConfigured() {
  return telegramConfigured() || whatsappConfigured();
}

function httpsRequest(url, { method = 'GET', body = null, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { method, hostname: u.hostname, path: u.pathname + u.search, port: u.port || 443,
        headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {} },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function sendTelegram(message) {
  const text = String(message).replace(/\*/g, '');
  const r = await httpsRequest(`https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`, {
    method: 'POST',
    body: JSON.stringify({ chat_id: config.telegram.chatId, text })
  });
  let json = null;
  try { json = JSON.parse(r.body); } catch (e) { /* ignora */ }
  if (r.status !== 200 || !json || !json.ok) {
    throw new Error('Telegram: ' + ((json && json.description) || 'HTTP ' + r.status));
  }
}


// Envia uma imagem (PNG) so para o Telegram (o WhatsApp gratis nao aceita imagem).
async function sendTelegramPhoto(buffer, caption) {
  if (!telegramConfigured()) throw new Error('Telegram nao configurado');
  const boundary = '----gp' + Date.now().toString(16);
  const parts = [];
  const field = (name, value) => parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  field('chat_id', config.telegram.chatId);
  if (caption) field('caption', String(caption).slice(0, 1000));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="painel.png"\r\nContent-Type: image/png\r\n\r\n`));
  parts.push(buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  const r = await new Promise((resolve, reject) => {
    const req = https.request({
      method: 'POST', hostname: 'api.telegram.org', path: `/bot${config.telegram.botToken}/sendPhoto`, port: 443,
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length }
    }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    req.on('error', reject); req.write(body); req.end();
  });
  let json = null; try { json = JSON.parse(r.body); } catch (e) { /* ignora */ }
  if (r.status !== 200 || !json || !json.ok) throw new Error('Telegram: ' + ((json && json.description) || 'HTTP ' + r.status));
}

async function sendWhatsapp(message) {
  const url =
    'https://api.callmebot.com/whatsapp.php' +
    `?phone=${encodeURIComponent(config.whatsapp.phone)}` +
    `&text=${encodeURIComponent(message)}` +
    `&apikey=${encodeURIComponent(config.whatsapp.apiKey)}`;
  const r = await httpsRequest(url);
  // O CallMeBot responde 200 mesmo quando recusa -- olha o corpo
  const body = String(r.body || '');
  if (r.status !== 200 || /(^|\D)0 messages left|bot is full|apikey is invalid|error/i.test(body.replace(/<[^>]*>/g, ' '))) {
    throw new Error('WhatsApp (CallMeBot): ' + body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) || 'HTTP ' + r.status);
  }
}

// Envia para todos os canais configurados. Resolve com { channels: {nome: 'ok'|erro} };
// rejeita se nenhum canal esta configurado ou se TODOS falharam.
// opts.skipWhatsappCap: testes manuais ignoram o teto diario do WhatsApp.
async function sendRaw(message, opts = {}) {
  if (!isConfigured()) {
    throw new Error('Nenhum canal de alerta configurado (Telegram: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID; WhatsApp: WHATSAPP_PHONE/WHATSAPP_APIKEY)');
  }
  const channels = {};
  const now = Date.now();
  const tasks = [];

  if (telegramConfigured()) {
    tasks.push(
      sendTelegram(`🌱 GrowPilot\n\n${message}`)
        .then(() => { channels.telegram = 'ok'; status.channels.telegram = { lastOk: new Date().toISOString(), lastError: null }; })
        .catch((e) => { channels.telegram = e.message; status.channels.telegram.lastError = e.message; })
    );
  }
  if (whatsappConfigured()) {
    while (whatsappSent.length && now - whatsappSent[0] > 24 * 3600 * 1000) whatsappSent.shift();
    if (!opts.skipWhatsappCap && whatsappSent.length >= WHATSAPP_MAX_PER_DAY) {
      channels.whatsapp = 'pulado (teto diario do WhatsApp para proteger a cota gratis)';
    } else {
      tasks.push(
        sendWhatsapp(`🌱 *GrowPilot*\n\n${message}`)
          .then(() => { channels.whatsapp = 'ok'; whatsappSent.push(Date.now()); status.channels.whatsapp = { lastOk: new Date().toISOString(), lastError: null }; })
          .catch((e) => { channels.whatsapp = e.message; status.channels.whatsapp.lastError = e.message; })
      );
    }
  }
  await Promise.all(tasks);

  const anyOk = Object.values(channels).some((v) => v === 'ok');
  if (anyOk) {
    status.lastSentAt = new Date().toISOString();
  } else {
    const err = Object.entries(channels).map(([k, v]) => `${k}: ${v}`).join(' | ');
    status.lastError = err;
    status.lastErrorAt = new Date().toISOString();
    const e = new Error(err || 'falha ao enviar');
    e.channels = channels;
    throw e;
  }
  return { channels };
}

// Envia um alerta respeitando cooldown crescente por tipo e o teto global.
async function sendAlert(type, message, opts = {}) {
  if (!config.alertsEnabled) return { sent: false, reason: 'alertas desativados (ALERTS_ENABLED=false)' };
  const now = Date.now();
  const s = state[type] || (state[type] = { lastSentAt: 0, repeats: 0, retryAt: 0 });

  if (opts.scheduled) { s.repeats = 0; s.lastSentAt = 0; } // mensagens agendadas (resumos/lembretes) nao sao 'problema repetido'
  if (s.lastSentAt && now - s.lastSentAt > RESET_AFTER_MS) s.repeats = 0;
  const cooldown = Math.min(BASE_COOLDOWN_MS * 2 ** s.repeats, MAX_COOLDOWN_MS);
  if (!opts.force && s.lastSentAt && now - s.lastSentAt < cooldown) return { sent: false, reason: 'em cooldown' };
  if (!opts.force && s.retryAt && now < s.retryAt) return { sent: false, reason: 'aguardando nova tentativa' };

  while (sentTimes.length && now - sentTimes[0] > 3600 * 1000) sentTimes.shift();
  if (!opts.force && sentTimes.length >= MAX_PER_HOUR) return { sent: false, reason: 'teto de alertas por hora atingido' };

  const suffix = s.repeats > 0 ? `\n\n(repetição ${s.repeats + 1} — o problema continua; próximo aviso desse tipo em ~${Math.round(Math.min(BASE_COOLDOWN_MS * 2 ** (s.repeats + 1), MAX_COOLDOWN_MS) / 60000)} min)` : '';
  try {
    const r = await sendRaw(message + suffix, { skipWhatsappCap: !!opts.force });
    s.lastSentAt = now;
    s.repeats = opts.scheduled ? 0 : s.repeats + 1;
    s.retryAt = 0;
    sentTimes.push(now);
    return { sent: true, channels: r.channels };
  } catch (e) {
    s.retryAt = now + FAILURE_RETRY_MS;
    console.error('[alerts] falha ao enviar alerta:', e.message);
    return { sent: false, reason: e.message };
  }
}

// Dispara sem esperar a resposta (fire-and-forget) -- para usar dentro do
// loop de controle sem atrasar a leitura de sensores esperando a rede.
function sendAlertAsync(type, message, opts) {
  sendAlert(type, message, opts).catch(() => {});
}

function getStatus() {
  return {
    enabled: !!config.alertsEnabled,
    telegram: { configured: telegramConfigured(), ...status.channels.telegram },
    whatsapp: { configured: whatsappConfigured(), ...status.channels.whatsapp, sentLast24h: whatsappSent.filter((t) => Date.now() - t < 24 * 3600 * 1000).length, dailyCap: WHATSAPP_MAX_PER_DAY },
    lastSentAt: status.lastSentAt,
    lastError: status.lastError,
    lastErrorAt: status.lastErrorAt
  };
}

// Ajuda na configuracao do Telegram: depois de mandar qualquer mensagem pro seu
// bot, isso le a ultima conversa e devolve o chat_id.
async function discoverTelegramChatId(botToken) {
  const token = botToken || (config.telegram && config.telegram.botToken);
  if (!token) throw new Error('Informe TELEGRAM_BOT_TOKEN no .env primeiro');
  const r = await httpsRequest(`https://api.telegram.org/bot${token}/getUpdates`);
  let json = null;
  try { json = JSON.parse(r.body); } catch (e) { /* ignora */ }
  if (!json || !json.ok) throw new Error('Telegram: ' + ((json && json.description) || 'HTTP ' + r.status));
  const chats = [];
  for (const u of json.result || []) {
    const m = u.message || u.channel_post;
    if (m && m.chat && !chats.find((c) => c.id === m.chat.id)) {
      chats.push({ id: m.chat.id, name: m.chat.first_name || m.chat.title || m.chat.username || '' });
    }
  }
  if (!chats.length) throw new Error('Nenhuma conversa encontrada. Abra o seu bot no Telegram, toque em Iniciar e mande "oi", depois tente de novo.');
  return chats;
}

module.exports = { sendTelegramPhoto, telegramConfigured, sendAlert, sendAlertAsync, sendRaw, isConfigured, getStatus, discoverTelegramChatId };
