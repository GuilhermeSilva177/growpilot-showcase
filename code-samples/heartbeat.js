// Heartbeat: o GrowPilot "avisa que esta vivo" a cada poucos minutos para um
// servico EXTERNO (ex: healthchecks.io, gratis). Se o PC desligar, a internet
// cair ou o programa travar, o servico externo percebe a falta do aviso e manda
// mensagem pra voce -- coisa que o proprio sistema nao consegue fazer quando esta fora do ar.
//
// .env:
//   HEARTBEAT_URL=https://hc-ping.com/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
//   HEARTBEAT_MINUTES=5   (opcional)
// Alem disso, quando o sistema liga (boot/reinicio), manda uma mensagem pelo
// Telegram/WhatsApp avisando que voltou -- util para perceber queda de energia.
const fs = require('fs');
const path = require('path');
const alerts = require('./alerts');
const BOOT_FILE = path.join(__dirname, '..', 'data', 'last-boot.txt');

const state = { url: null, everyMin: 5, lastOkAt: null, lastError: null, lastTryAt: null };

async function ping() {
  state.lastTryAt = new Date().toISOString();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const r = await fetch(state.url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    state.lastOkAt = new Date().toISOString();
    state.lastError = null;
  } catch (e) {
    state.lastError = e.name === 'AbortError' ? 'timeout' : e.message;
  }
}

function start() {
  const url = (process.env.HEARTBEAT_URL || '').trim();
  state.everyMin = Math.max(1, Number(process.env.HEARTBEAT_MINUTES) || 5);
  if (url) {
    state.url = url;
    ping();
    setInterval(ping, state.everyMin * 60 * 1000).unref();
  }
  // aviso de "voltei" (cooldown evita spam em reinicios seguidos durante atualizacoes)
  try {
    // evita enxurrada de mensagens se o programa ficar reiniciando em loop (so 1 aviso a cada 15 min)
    let last = 0;
    try { last = Number(fs.readFileSync(BOOT_FILE, 'utf8')) || 0; } catch (e) { /* primeira vez */ }
    if (Date.now() - last < 15 * 60 * 1000) return;
    try { fs.writeFileSync(BOOT_FILE, String(Date.now())); } catch (e) { /* melhor esforco */ }
    alerts.sendAlertAsync('system_boot', '🟢 GrowPilot iniciou (ou reiniciou). Se você não reiniciou de propósito, pode ter havido queda de energia/travamento.', { scheduled: true });
  } catch (e) { /* melhor esforco */ }
}

function getStatus() {
  return { configured: !!state.url, everyMin: state.everyMin, lastOkAt: state.lastOkAt, lastError: state.lastError, lastTryAt: state.lastTryAt };
}

module.exports = { start, getStatus };
