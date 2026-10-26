// Autenticacao e niveis de acesso do painel.
//
// Niveis:
//   master    (Mastergrower) -- tudo: clima, equipamentos, configuracoes, usuarios
//   auxiliar  (Auxiliar)     -- ve tudo; pode ativar cena de nutrientes, ligar
//                               recirculacao, parar irrigacao, e usar diario/fotos.
//                               NAO dispara irrigacao nem altera configuracoes.
//   visitante (Visitante)    -- so visualiza
//
// Senhas: scrypt com salt individual. Sessao: cookie HttpOnly com token aleatorio
// (so o hash fica salvo no disco). Rotas /api exigem login; a verificacao de
// permissao e SEMPRE no servidor (a tela so reflete isso).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const AUDIT_FILE = path.join(DATA_DIR, 'auth-log.json');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');

const COOKIE = 'gp_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const ROLES = { master: 'Mastergrower', auxiliar: 'Auxiliar', visitante: 'Visitante' };
const AUTH_DISABLED = process.env.AUTH_DISABLED === 'true'; // saida de emergencia

// ---- Regras de permissao (o front recebe estas mesmas regras em /api/auth/me) ----
// GETs que so o master pode fazer (gastam cota da Tuya, mandam mensagem ou expoem administracao)
const MASTER_ONLY_GET = [
  '^/api/users',
  '^/api/alerts/(test|telegram-chat-id)',
  '^/api/ac/status',
  '^/api/ir/keys',
  '^/api/backup'
];
// Escritas (POST/DELETE) que o auxiliar tambem pode fazer
const AUX_WRITE = [
  '^/api/journal(/|$)',
  '^/api/photos(/|$)',
  '^/api/irrigation/(nutrient-scene|manual-recirc|cancel)$',
  '^/api/tasks/[^/]+/done$',
  '^/api/auth/(password|logout|profile|avatar)$'
];
// Escritas liberadas ate para o visitante
const ANY_WRITE = ['^/api/auth/(password|logout|profile|avatar)$'];

const rx = (list) => list.map((s) => new RegExp(s));
const MASTER_ONLY_GET_RX = rx(MASTER_ONLY_GET);
const AUX_WRITE_RX = rx(AUX_WRITE);
const ANY_WRITE_RX = rx(ANY_WRITE);

function can(role, method, pathname) {
  if (role === 'master') return true;
  if (role !== 'auxiliar' && role !== 'visitante') return false;
  if (method === 'GET' || method === 'HEAD') return !MASTER_ONLY_GET_RX.some((r) => r.test(pathname));
  if (ANY_WRITE_RX.some((r) => r.test(pathname))) return true;
  if (role === 'auxiliar') return AUX_WRITE_RX.some((r) => r.test(pathname));
  return false;
}

// ---- Persistencia simples em JSON ----
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}
function writeJson(file, obj) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

let users = readJson(USERS_FILE, { users: [] });
if (!Array.isArray(users.users)) users = { users: [] };
let sessions = readJson(SESSIONS_FILE, { sessions: {} });
if (!sessions.sessions) sessions = { sessions: {} };

function saveUsers() { writeJson(USERS_FILE, users); }

// ---- Historico de acessos e alteracoes de contas (ultimos 300 eventos) ----
let auditLog = readJson(AUDIT_FILE, []);
if (!Array.isArray(auditLog)) auditLog = [];
function audit(event, { by, target, ip, detail } = {}) {
  auditLog.push({ t: new Date().toISOString(), event, by: by || null, target: target || null, ip: ip || null, detail: detail || null });
  if (auditLog.length > 300) auditLog = auditLog.slice(-300);
  try { writeJson(AUDIT_FILE, auditLog); } catch (e) { /* melhor esforco */ }
}
function saveSessions() { writeJson(SESSIONS_FILE, sessions); }

// ---- Senhas ----
function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}
function verifyPassword(password, user) {
  const { hash } = hashPassword(password, user.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validateUsername(u) {
  const name = String(u || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(name)) throw new Error('Usuário: 3 a 32 caracteres (letras, números, ponto, hífen ou _).');
  return name;
}
function validatePassword(p) {
  if (typeof p !== 'string' || p.length < 8) throw new Error('A senha precisa ter pelo menos 8 caracteres.');
  if (p.length > 200) throw new Error('Senha longa demais.');
  return p;
}

function publicUser(u, { admin } = {}) {
  const out = {
    id: u.id, username: u.username, displayName: u.displayName || u.username, email: u.email || '',
    avatarV: u.avatarV || null, role: u.role, roleLabel: ROLES[u.role], disabled: !!u.disabled,
    mustChangePassword: !!u.mustChangePassword, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null
  };
  if (admin) out.activeSessions = countSessions(u.id);
  return out;
}

function validateEmail(e) {
  const v = String(e || '').trim().toLowerCase();
  if (!v) return '';
  if (v.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new Error('E-mail inválido.');
  return v;
}
function ensureUniqueIdentity(username, email, exceptId) {
  if (username && users.users.some((u) => u.id !== exceptId && u.username === username)) throw new Error('Esse usuário já existe.');
  if (email && users.users.some((u) => u.id !== exceptId && (u.email || '') === email)) throw new Error('Esse e-mail já está em uso por outra conta.');
}

// ---- Foto de perfil (arquivo em data/avatars/) ----
function saveAvatar(user, dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new Error('Imagem inválida (use JPG, PNG ou WebP).');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 400 * 1024) throw new Error('Imagem grande demais (máx. 400 KB depois de reduzida).');
  if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });
  removeAvatarFile(user);
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const file = `${user.id}.${ext}`;
  fs.writeFileSync(path.join(AVATAR_DIR, file), buf);
  user.avatarFile = file;
  user.avatarV = Date.now();
}
function removeAvatarFile(user) {
  if (user.avatarFile) { try { fs.unlinkSync(path.join(AVATAR_DIR, user.avatarFile)); } catch (e) { /* ja nao existe */ } }
  user.avatarFile = null;
  user.avatarV = null;
}

function activeMasters() {
  return users.users.filter((u) => u.role === 'master' && !u.disabled);
}

// ---- Usuarios ----
function hasUsers() { return users.users.length > 0; }

function createUser({ username, password, role, displayName, email, mustChangePassword }) {
  const name = validateUsername(username);
  validatePassword(password);
  if (!ROLES[role]) throw new Error('Nível inválido.');
  const mail = validateEmail(email);
  ensureUniqueIdentity(name, mail, null);
  const { salt, hash } = hashPassword(password);
  const user = { id: crypto.randomBytes(6).toString('hex'), username: name, displayName: String(displayName || '').trim().slice(0, 60) || name, email: mail, role, salt, hash, disabled: false, mustChangePassword: !!mustChangePassword, createdAt: new Date().toISOString() };
  users.users.push(user);
  saveUsers();
  return user;
}

function updateUser(id, patch) {
  const u = users.users.find((x) => x.id === id);
  if (!u) throw new Error('Usuário não encontrado.');
  const wasActiveMaster = u.role === 'master' && !u.disabled;
  if (patch.role !== undefined) {
    if (!ROLES[patch.role]) throw new Error('Nível inválido.');
    u.role = patch.role;
  }
  if (patch.disabled !== undefined) u.disabled = !!patch.disabled;
  if (patch.username !== undefined) { const nn = validateUsername(patch.username); ensureUniqueIdentity(nn, null, u.id); u.username = nn; }
  if (patch.email !== undefined) { const mail = validateEmail(patch.email); ensureUniqueIdentity(null, mail, u.id); u.email = mail; }
  if (patch.displayName !== undefined) u.displayName = String(patch.displayName).trim().slice(0, 60) || u.username;
  if (patch.removeAvatar) removeAvatarFile(u);
  if (patch.password) {
    validatePassword(patch.password);
    Object.assign(u, hashPassword(patch.password));
    u.mustChangePassword = patch.mustChangePassword !== false; // senha definida pelo admin: a pessoa troca no proximo acesso
  }
  const stillActiveMaster = u.role === 'master' && !u.disabled;
  if (wasActiveMaster && !stillActiveMaster && activeMasters().length === 0) {
    throw new Error('Precisa existir pelo menos um Mastergrower ativo.');
  }
  saveUsers();
  if (u.disabled || patch.password || (patch.role !== undefined)) revokeSessionsOf(u.id);
  return u;
}

function deleteUser(id) {
  const u = users.users.find((x) => x.id === id);
  if (!u) throw new Error('Usuário não encontrado.');
  if (u.role === 'master' && !u.disabled && activeMasters().length <= 1) throw new Error('Precisa existir pelo menos um Mastergrower ativo.');
  removeAvatarFile(u);
  users.users = users.users.filter((x) => x.id !== id);
  saveUsers();
  revokeSessionsOf(id);
}

// ---- Sessoes ----
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

function createSession(user, req) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.sessions[sha(token)] = { userId: user.id, createdAt: now, expiresAt: now + SESSION_TTL_MS, ua: String(req.headers['user-agent'] || '').slice(0, 120) };
  // limpa expiradas
  for (const k of Object.keys(sessions.sessions)) if (sessions.sessions[k].expiresAt < now) delete sessions.sessions[k];
  saveSessions();
  return token;
}
function revokeSessionsOf(userId) {
  let changed = false;
  for (const k of Object.keys(sessions.sessions)) {
    if (sessions.sessions[k].userId === userId) { delete sessions.sessions[k]; changed = true; }
  }
  if (changed) saveSessions();
}
function countSessions(userId) {
  const now = Date.now();
  return Object.values(sessions.sessions).filter((s) => s.userId === userId && s.expiresAt > now).length;
}
function destroySession(token) {
  if (token && sessions.sessions[sha(token)]) { delete sessions.sessions[sha(token)]; saveSessions(); }
}

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function userFromRequest(req) {
  if (AUTH_DISABLED) return { id: 'auth-disabled', username: 'local', displayName: 'Acesso livre', role: 'master' };
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const s = sessions.sessions[sha(token)];
  if (!s || s.expiresAt < Date.now()) return null;
  const u = users.users.find((x) => x.id === s.userId);
  if (!u || u.disabled) return null;
  // renovacao deslizante: se faltam menos de 15 dias, estende
  if (s.expiresAt - Date.now() < SESSION_TTL_MS / 2) { s.expiresAt = Date.now() + SESSION_TTL_MS; saveSessions(); }
  return u;
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

// ---- Limite de tentativas de login ----
const attempts = new Map(); // chave -> { count, lockUntil }
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;
function checkLock(key) {
  const a = attempts.get(key);
  if (a && a.lockUntil && a.lockUntil > Date.now()) return Math.ceil((a.lockUntil - Date.now()) / 60000);
  return 0;
}
function registerFailure(key) {
  const a = attempts.get(key) || { count: 0, lockUntil: 0 };
  a.count += 1;
  if (a.count >= MAX_ATTEMPTS) { a.lockUntil = Date.now() + LOCK_MS; a.count = 0; }
  attempts.set(key, a);
}

function clientIp(req) {
  return String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
}
// Cadastro inicial so de rede local/privada/Tailscale -- nunca de IP publico
function isPrivateIp(ip) {
  return (
    ip === '::1' || /^127\./.test(ip) || /^10\./.test(ip) || /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) ||
    /^f[cd][0-9a-f]{2}:/i.test(ip) || /^fe80:/i.test(ip)
  );
}

// ---- Rotas ----
function registerRoutes(app) {
  const authRules = { masterOnlyGet: MASTER_ONLY_GET, auxWrite: AUX_WRITE, anyWrite: ANY_WRITE };

  app.get('/api/auth/me', (req, res) => {
    const u = userFromRequest(req);
    if (!u) return res.status(401).json({ ok: false, needsSetup: !hasUsers() && !AUTH_DISABLED });
    res.json({ ok: true, user: publicUser(u.id === 'auth-disabled' ? { ...u, createdAt: null } : u), rules: authRules });
  });

  app.post('/api/auth/setup', (req, res) => {
    if (hasUsers()) return res.status(403).json({ ok: false, error: 'O cadastro inicial já foi feito.' });
    if (!isPrivateIp(clientIp(req))) return res.status(403).json({ ok: false, error: 'O cadastro inicial só pode ser feito pela rede local ou Tailscale.' });
    try {
      const user = createUser({ ...req.body, role: 'master' });
      setSessionCookie(res, createSession(user, req));
      audit('conta_inicial_criada', { by: user.username, ip: clientIp(req) });
      res.json({ ok: true, user: publicUser(user) });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/auth/login', (req, res) => {
    const username = String((req.body && req.body.username) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');
    const keys = [`ip:${clientIp(req)}`, `user:${username}`];
    const locked = Math.max(...keys.map(checkLock));
    if (locked) return res.status(429).json({ ok: false, error: `Muitas tentativas. Tente de novo em ${locked} min.` });
    const user = users.users.find((u) => u.username === username || (u.email && u.email === username));
    // faz o hash mesmo se o usuario nao existe, para nao revelar por tempo de resposta
    const okPass = user ? verifyPassword(password, user) : (hashPassword(password), false);
    if (!user || !okPass || user.disabled) {
      keys.forEach(registerFailure);
      audit(user && user.disabled ? 'login_bloqueado_desativado' : 'login_falhou', { by: username.slice(0, 40), ip: clientIp(req) });
      return res.status(401).json({ ok: false, error: user && user.disabled ? 'Usuário desativado.' : 'Usuário ou senha incorretos.' });
    }
    keys.forEach((k) => attempts.delete(k));
    user.lastLoginAt = new Date().toISOString();
    saveUsers();
    audit('login', { by: user.username, ip: clientIp(req) });
    setSessionCookie(res, createSession(user, req));
    res.json({ ok: true, user: publicUser(user) });
  });

  app.post('/api/auth/logout', (req, res) => {
    destroySession(parseCookies(req)[COOKIE]);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.post('/api/auth/password', (req, res) => {
    const me = req.user;
    const user = users.users.find((u) => u.id === me.id);
    if (!user) return res.status(400).json({ ok: false, error: 'Conta de acesso livre não tem senha.' });
    const { currentPassword, newPassword } = req.body || {};
    if (!verifyPassword(String(currentPassword || ''), user)) return res.status(400).json({ ok: false, error: 'Senha atual incorreta.' });
    try {
      validatePassword(newPassword);
      Object.assign(user, hashPassword(newPassword));
      user.mustChangePassword = false;
      saveUsers();
      audit('senha_alterada', { by: user.username, ip: clientIp(req) });
      revokeSessionsOf(user.id);
      setSessionCookie(res, createSession(user, req)); // mantem esta sessao ativa
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // ---- Minha conta: editar nome, usuario, e-mail e foto (qualquer nivel) ----
  app.post('/api/auth/profile', (req, res) => {
    const user = users.users.find((u) => u.id === req.user.id);
    if (!user) return res.status(400).json({ ok: false, error: 'Conta de acesso livre não tem perfil.' });
    try {
      const b = req.body || {};
      const next = {};
      if (b.displayName !== undefined) next.displayName = String(b.displayName).trim().slice(0, 60) || user.username;
      if (b.email !== undefined) { next.email = validateEmail(b.email); ensureUniqueIdentity(null, next.email, user.id); }
      if (b.username !== undefined && validateUsername(b.username) !== user.username) {
        if (!verifyPassword(String(b.currentPassword || ''), user)) throw new Error('Para trocar o nome de usuário, informe a senha atual corretamente.');
        next.username = validateUsername(b.username);
        ensureUniqueIdentity(next.username, null, user.id);
      }
      const before = user.username;
      Object.assign(user, next);
      saveUsers();
      if (next.username && next.username !== before) audit('usuario_renomeado', { by: before, target: next.username, ip: clientIp(req) });
      res.json({ ok: true, user: publicUser(user) });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  app.post('/api/auth/avatar', (req, res) => {
    const user = users.users.find((u) => u.id === req.user.id);
    if (!user) return res.status(400).json({ ok: false, error: 'Conta de acesso livre não tem foto.' });
    try {
      if (req.body && req.body.remove) removeAvatarFile(user);
      else saveAvatar(user, req.body && req.body.dataUrl);
      saveUsers();
      res.json({ ok: true, user: publicUser(user) });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  app.get('/api/auth/avatar/:id', (req, res) => {
    const u = users.users.find((x) => x.id === req.params.id);
    if (!u || !u.avatarFile) return res.status(404).end();
    const f = path.join(AVATAR_DIR, path.basename(u.avatarFile));
    if (!fs.existsSync(f)) return res.status(404).end();
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(f);
  });

  // ---- Gestao de usuarios (so master -- garantido pelo middleware: ^/api/users) ----
  app.get('/api/users', (req, res) => res.json({ ok: true, users: users.users.map((u) => publicUser(u, { admin: true })), roles: ROLES }));
  app.get('/api/users/audit', (req, res) => res.json({ ok: true, events: auditLog.slice(-150).reverse() }));
  app.post('/api/users/:id/logout', (req, res) => {
    const u = users.users.find((x) => x.id === req.params.id);
    if (!u) return res.status(404).json({ ok: false, error: 'Usuário não encontrado.' });
    revokeSessionsOf(u.id);
    audit('sessoes_encerradas', { by: req.user.username, target: u.username, ip: clientIp(req) });
    res.json({ ok: true });
  });
  app.post('/api/users', (req, res) => {
    try {
      const created = createUser({ ...(req.body || {}), mustChangePassword: true });
      audit('conta_criada', { by: req.user.username, target: created.username, ip: clientIp(req), detail: ROLES[created.role] });
      res.json({ ok: true, user: publicUser(created, { admin: true }) });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });
  app.post('/api/users/:id', (req, res) => {
    try {
      if (req.params.id === req.user.id && req.body && (req.body.disabled || (req.body.role && req.body.role !== 'master'))) {
        return res.status(400).json({ ok: false, error: 'Você não pode desativar nem rebaixar a própria conta.' });
      }
      const b = req.body || {};
      const before = users.users.find((x) => x.id === req.params.id);
      const beforeName = before && before.username;
      const updated = updateUser(req.params.id, b);
      const what = [b.role !== undefined && 'nível→' + ROLES[updated.role], b.disabled !== undefined && (updated.disabled ? 'desativada' : 'reativada'), b.password && 'senha redefinida', b.username !== undefined && 'usuário', b.email !== undefined && 'e-mail', b.displayName !== undefined && 'nome', b.removeAvatar && 'foto removida'].filter(Boolean).join(', ');
      audit('conta_alterada', { by: req.user.username, target: beforeName, ip: clientIp(req), detail: what });
      res.json({ ok: true, user: publicUser(updated, { admin: true }) });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });
  app.delete('/api/users/:id', (req, res) => {
    try {
      if (req.params.id === req.user.id) return res.status(400).json({ ok: false, error: 'Você não pode excluir a própria conta.' });
      const gone = users.users.find((x) => x.id === req.params.id);
      deleteUser(req.params.id);
      audit('conta_excluida', { by: req.user.username, target: gone && gone.username, ip: clientIp(req) });
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });
}

// ---- Middleware: aplica login + permissao em tudo que e /api ----
const PUBLIC = [/^\/api\/auth\/(login|setup|me)$/];
function middleware(req, res, next) {
  const full = '/api' + req.path;
  if (PUBLIC.some((r) => r.test(full))) return next();
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Faça login para continuar.', needsSetup: !hasUsers() });
  if (!can(user.role, req.method, full)) {
    return res.status(403).json({ ok: false, error: `Seu nível (${ROLES[user.role]}) não permite essa ação.` });
  }
  req.user = user;
  next();
}

module.exports = { registerRoutes, middleware, can, createUser, updateUser, hasUsers, userFromRequest, ROLES, _users: () => users };
