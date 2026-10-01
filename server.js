'use strict';
/**
 * Сервисный центр — заявки на закупку запчастей.
 * Без внешних зависимостей: Node.js >= 22.13 (рекомендуется 24 LTS), встроенный SQLite.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_DAYS = 14;
const SECURE_COOKIE = process.env.SECURE_COOKIE === '1';

const STATUSES = {
  new: 'Новая',
  processing: 'В обработке',
  ordered: 'Заказано у поставщика',
  purchased: 'Куплено',
  received: 'Получено на склад',
  done: 'Выполнено (выдано мастеру)',
  cancelled: 'Отменено',
};
const PRIORITIES = { low: 'Низкий', normal: 'Обычный', high: 'Высокий', urgent: 'Срочно' };
const ROLES = { admin: 'Администратор', manager: 'Менеджер закупок', master: 'Мастер' };

/* ---------------------------- База данных ---------------------------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'service.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'master',
  active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS parts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sku TEXT DEFAULT '',
  category TEXT DEFAULT '',
  brand TEXT DEFAULT '',
  compatible TEXT DEFAULT '',
  supplier TEXT DEFAULT '',
  price REAL NOT NULL DEFAULT 0,
  sale_price REAL NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  description TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  ticket TEXT DEFAULT '',
  device TEXT DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'normal',
  comment TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  total REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  part_id INTEGER REFERENCES parts(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  sku TEXT DEFAULT '',
  price REAL NOT NULL DEFAULT 0,
  qty INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS order_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT,
  comment TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_hist_order ON order_history(order_id);
`);

const now = () => new Date().toISOString();
const q = (sql) => db.prepare(sql);
function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

/* ---------------------------- Пароли / сессии ---------------------------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 64);
  const real = Buffer.from(hash, 'hex');
  return real.length === test.length && crypto.timingSafeEqual(real, test);
}
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  q('INSERT INTO sessions (token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(token, userId, now(), exp);
  return token;
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function sessionCookie(token, maxAge) {
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${SECURE_COOKIE ? '; Secure' : ''}`;
}
function currentUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const u = q(`SELECT u.id,u.name,u.email,u.phone,u.role,u.active,u.created_at FROM sessions s
    JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?`).get(token, now());
  if (!u || !u.active) return null;
  return u;
}
setInterval(() => q('DELETE FROM sessions WHERE expires_at<?').run(now()), 36e5).unref();

/* Защита от перебора паролей */
const attempts = new Map();
function tooMany(key) {
  const a = attempts.get(key);
  return a && a.count >= 8 && Date.now() - a.first < 15 * 60e3;
}
function failAttempt(key) {
  const a = attempts.get(key);
  if (!a || Date.now() - a.first > 15 * 60e3) attempts.set(key, { count: 1, first: Date.now() });
  else a.count++;
}

/* ---------------------------- HTTP утилиты ---------------------------- */
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fail = (code, msg) => { throw new HttpError(code, msg); };

function send(res, code, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 1e6) { reject(new HttpError(413, 'Слишком большой запрос')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Некорректный JSON')); }
    });
    req.on('error', reject);
  });
}
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const num = (v, def = 0) => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : def; };
const int = (v, def = 0) => Math.trunc(num(v, def));
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

function requireRole(user, ...roles) {
  if (!user) fail(401, 'Требуется вход');
  if (roles.length && !roles.includes(user.role)) fail(403, 'Недостаточно прав');
}
const isStaff = (u) => u && (u.role === 'admin' || u.role === 'manager');

/* ---------------------------- Роутер ---------------------------- */
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
};

/* ---- Auth ---- */
route('GET', '/api/meta', () => ({ statuses: STATUSES, priorities: PRIORITIES, roles: ROLES }));

route('POST', '/api/auth/register', async ({ body }) => {
  const name = str(body.name, 100), email = str(body.email, 150).toLowerCase(), phone = str(body.phone, 30);
  const password = String(body.password || '');
  if (name.length < 2) fail(400, 'Укажите имя');
  if (!isEmail(email)) fail(400, 'Некорректный email');
  if (password.length < 6) fail(400, 'Пароль должен быть не короче 6 символов');
  if (q('SELECT id FROM users WHERE email=?').get(email)) fail(409, 'Пользователь с таким email уже существует');
  const isFirst = q('SELECT COUNT(*) c FROM users').get().c === 0;
  q('INSERT INTO users (name,email,phone,password_hash,role,active,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(name, email, phone, hashPassword(password), isFirst ? 'admin' : 'master', isFirst ? 1 : 0, now());
  return { ok: true, pending: !isFirst, message: isFirst
    ? 'Вы первый пользователь — вам выданы права администратора. Войдите в систему.'
    : 'Регистрация прошла успешно. Дождитесь подтверждения администратором.' };
});

route('POST', '/api/auth/login', async ({ body, req, res }) => {
  const email = str(body.email, 150).toLowerCase();
  const key = (req.socket.remoteAddress || '') + '|' + email;
  if (tooMany(key)) fail(429, 'Слишком много попыток. Повторите через 15 минут');
  const u = q('SELECT * FROM users WHERE email=?').get(email);
  if (!u || !verifyPassword(String(body.password || ''), u.password_hash)) { failAttempt(key); fail(401, 'Неверный email или пароль'); }
  if (!u.active) fail(403, 'Аккаунт ещё не подтверждён администратором или заблокирован');
  attempts.delete(key);
  const token = createSession(u.id);
  res.setHeader('Set-Cookie', sessionCookie(token, SESSION_DAYS * 86400));
  return { ok: true };
});

route('POST', '/api/auth/logout', ({ req, res }) => {
  const token = parseCookies(req).sid;
  if (token) q('DELETE FROM sessions WHERE token=?').run(token);
  res.setHeader('Set-Cookie', sessionCookie('', 0));
  return { ok: true };
});

route('GET', '/api/auth/me', ({ user }) => ({ user }));

route('POST', '/api/auth/password', ({ user, body }) => {
  requireRole(user);
  const u = q('SELECT password_hash FROM users WHERE id=?').get(user.id);
  if (!verifyPassword(String(body.current || ''), u.password_hash)) fail(400, 'Текущий пароль неверен');
  if (String(body.password || '').length < 6) fail(400, 'Новый пароль должен быть не короче 6 символов');
  q('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(body.password), user.id);
  return { ok: true };
});

/* ---- Пользователи (админ) ---- */
route('GET', '/api/users', ({ user }) => {
  requireRole(user, 'admin');
  return q(`SELECT u.id,u.name,u.email,u.phone,u.role,u.active,u.created_at,
    (SELECT COUNT(*) FROM orders o WHERE o.user_id=u.id) orders_count FROM users u ORDER BY u.active ASC, u.created_at DESC`).all();
});
route('POST', '/api/users', ({ user, body }) => {
  requireRole(user, 'admin');
  const name = str(body.name, 100), email = str(body.email, 150).toLowerCase();
  const role = ROLES[body.role] ? body.role : 'master';
  if (name.length < 2 || !isEmail(email)) fail(400, 'Проверьте имя и email');
  if (String(body.password || '').length < 6) fail(400, 'Пароль должен быть не короче 6 символов');
  if (q('SELECT id FROM users WHERE email=?').get(email)) fail(409, 'Email уже занят');
  q('INSERT INTO users (name,email,phone,password_hash,role,active,created_at) VALUES (?,?,?,?,?,1,?)')
    .run(name, email, str(body.phone, 30), hashPassword(body.password), role, now());
  return { ok: true };
});
route('PATCH', '/api/users/:id', ({ user, body, params }) => {
  requireRole(user, 'admin');
  const id = int(params.id);
  const target = q('SELECT * FROM users WHERE id=?').get(id) || fail(404, 'Пользователь не найден');
  if (id === user.id && ((body.role && body.role !== 'admin') || body.active === false))
    fail(400, 'Нельзя снять права администратора или заблокировать самого себя');
  if (body.role !== undefined) { if (!ROLES[body.role]) fail(400, 'Неизвестная роль'); q('UPDATE users SET role=? WHERE id=?').run(body.role, id); }
  if (body.active !== undefined) {
    q('UPDATE users SET active=? WHERE id=?').run(body.active ? 1 : 0, id);
    if (!body.active) q('DELETE FROM sessions WHERE user_id=?').run(id);
  }
  if (body.name !== undefined) q('UPDATE users SET name=? WHERE id=?').run(str(body.name, 100) || target.name, id);
  if (body.phone !== undefined) q('UPDATE users SET phone=? WHERE id=?').run(str(body.phone, 30), id);
  if (body.password) {
    if (String(body.password).length < 6) fail(400, 'Пароль должен быть не короче 6 символов');
    q('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(body.password), id);
    q('DELETE FROM sessions WHERE user_id=?').run(id);
  }
  return { ok: true };
});
route('DELETE', '/api/users/:id', ({ user, params }) => {
  requireRole(user, 'admin');
  const id = int(params.id);
  if (id === user.id) fail(400, 'Нельзя удалить самого себя');
  if (q('SELECT COUNT(*) c FROM orders WHERE user_id=?').get(id).c > 0)
    fail(400, 'У пользователя есть заявки — заблокируйте его вместо удаления');
  q('DELETE FROM users WHERE id=?').run(id);
  return { ok: true };
});

/* ---- Каталог запчастей ---- */
function partFromBody(body) {
  const p = {
    name: str(body.name, 200), sku: str(body.sku, 80), category: str(body.category, 80), brand: str(body.brand, 80),
    compatible: str(body.compatible, 300), supplier: str(body.supplier, 120), price: Math.max(0, num(body.price)),
    sale_price: Math.max(0, num(body.sale_price)), stock: Math.max(0, int(body.stock)), description: str(body.description, 1000),
    active: body.active === false ? 0 : 1,
  };
  if (p.name.length < 2) fail(400, 'Укажите название детали');
  return p;
}
route('GET', '/api/parts', ({ user, url }) => {
  requireRole(user);
  const s = url.searchParams;
  const where = []; const args = [];
  if (!(isStaff(user) && s.get('all') === '1')) where.push('active=1');
  if (s.get('q')) { where.push('(name LIKE ? OR sku LIKE ? OR brand LIKE ? OR compatible LIKE ?)'); const l = `%${s.get('q')}%`; args.push(l, l, l, l); }
  if (s.get('category')) { where.push('category=?'); args.push(s.get('category')); }
  return q(`SELECT * FROM parts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY category, name`).all(...args);
});
route('GET', '/api/parts/categories', ({ user }) => {
  requireRole(user);
  return q("SELECT DISTINCT category FROM parts WHERE category<>'' ORDER BY category").all().map((r) => r.category);
});
route('POST', '/api/parts', ({ user, body }) => {
  requireRole(user, 'admin', 'manager');
  const p = partFromBody(body); const t = now();
  const r = q(`INSERT INTO parts (name,sku,category,brand,compatible,supplier,price,sale_price,stock,description,active,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(p.name, p.sku, p.category, p.brand, p.compatible, p.supplier, p.price, p.sale_price, p.stock, p.description, p.active, t, t);
  return { id: Number(r.lastInsertRowid) };
});
route('PUT', '/api/parts/:id', ({ user, body, params }) => {
  requireRole(user, 'admin', 'manager');
  const p = partFromBody(body);
  const r = q(`UPDATE parts SET name=?,sku=?,category=?,brand=?,compatible=?,supplier=?,price=?,sale_price=?,stock=?,description=?,active=?,updated_at=? WHERE id=?`)
    .run(p.name, p.sku, p.category, p.brand, p.compatible, p.supplier, p.price, p.sale_price, p.stock, p.description, p.active, now(), int(params.id));
  if (!r.changes) fail(404, 'Деталь не найдена');
  return { ok: true };
});
route('DELETE', '/api/parts/:id', ({ user, params }) => {
  requireRole(user, 'admin', 'manager');
  const id = int(params.id);
  const used = q('SELECT COUNT(*) c FROM order_items WHERE part_id=?').get(id).c;
  if (used) { q('UPDATE parts SET active=0, updated_at=? WHERE id=?').run(now(), id); return { ok: true, archived: true }; }
  q('DELETE FROM parts WHERE id=?').run(id);
  return { ok: true };
});

/* ---- Заявки ---- */
const ORDER_SELECT = `SELECT o.*, u.name user_name, u.email user_email,
  (SELECT COUNT(*) FROM order_items i WHERE i.order_id=o.id) items_count,
  (SELECT GROUP_CONCAT(i.name, ', ') FROM order_items i WHERE i.order_id=o.id) items_names
  FROM orders o JOIN users u ON u.id=o.user_id`;

function listOrders(user, s) {
  const where = []; const args = [];
  if (!isStaff(user)) { where.push('o.user_id=?'); args.push(user.id); }
  else if (s.get('user')) { where.push('o.user_id=?'); args.push(int(s.get('user'))); }
  if (s.get('mine') === '1') { where.push('o.user_id=?'); args.push(user.id); }
  if (s.get('status') === 'active') where.push("o.status NOT IN ('done','cancelled')");
  else if (s.get('status') && STATUSES[s.get('status')]) { where.push('o.status=?'); args.push(s.get('status')); }
  if (s.get('from')) { where.push('o.created_at>=?'); args.push(new Date(s.get('from')).toISOString()); }
  if (s.get('to')) { where.push('o.created_at<?'); args.push(new Date(new Date(s.get('to')).getTime() + 864e5).toISOString()); }
  if (s.get('q')) {
    const l = `%${s.get('q')}%`;
    where.push(`(o.ticket LIKE ? OR o.device LIKE ? OR o.comment LIKE ? OR u.name LIKE ? OR CAST(o.id AS TEXT)=? OR EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id AND (i.name LIKE ? OR i.sku LIKE ?)))`);
    args.push(l, l, l, l, s.get('q').replace('#', ''), l, l);
  }
  return q(`${ORDER_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.created_at DESC LIMIT 1000`).all(...args);
}
function getOrder(user, id) {
  const o = q(`${ORDER_SELECT} WHERE o.id=?`).get(id) || fail(404, 'Заявка не найдена');
  if (!isStaff(user) && o.user_id !== user.id) fail(403, 'Нет доступа к этой заявке');
  o.items = q('SELECT * FROM order_items WHERE order_id=? ORDER BY id').all(id);
  o.history = q(`SELECT h.*, u.name user_name FROM order_history h LEFT JOIN users u ON u.id=h.user_id WHERE h.order_id=? ORDER BY h.id`).all(id);
  return o;
}

route('GET', '/api/orders', ({ user, url }) => { requireRole(user); return listOrders(user, url.searchParams); });
route('GET', '/api/orders/:id', ({ user, params }) => { requireRole(user); return getOrder(user, int(params.id)); });

route('POST', '/api/orders', ({ user, body }) => {
  requireRole(user);
  const items = Array.isArray(body.items) ? body.items.slice(0, 100) : [];
  if (!items.length) fail(400, 'Добавьте хотя бы одну деталь');
  const prepared = items.map((it) => {
    const qty = Math.max(1, Math.min(9999, int(it.qty, 1)));
    if (it.part_id) {
      const p = q('SELECT * FROM parts WHERE id=? AND active=1').get(int(it.part_id)) || fail(400, 'Деталь из каталога не найдена или снята с продажи');
      return { part_id: p.id, name: p.name, sku: p.sku, price: p.price, qty };
    }
    const name = str(it.name, 200);
    if (name.length < 2) fail(400, 'Укажите название для детали не из каталога');
    return { part_id: null, name, sku: str(it.sku, 80), price: Math.max(0, num(it.price)), qty };
  });
  const priority = PRIORITIES[body.priority] ? body.priority : 'normal';
  const total = prepared.reduce((s, i) => s + i.price * i.qty, 0);
  const t = now();
  const id = tx(() => {
    const r = q('INSERT INTO orders (user_id,ticket,device,priority,comment,status,total,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(user.id, str(body.ticket, 60), str(body.device, 200), priority, str(body.comment, 2000), 'new', Math.round(total * 100) / 100, t, t);
    const oid = Number(r.lastInsertRowid);
    const ins = q('INSERT INTO order_items (order_id,part_id,name,sku,price,qty) VALUES (?,?,?,?,?,?)');
    prepared.forEach((i) => ins.run(oid, i.part_id, i.name, i.sku, i.price, i.qty));
    q('INSERT INTO order_history (order_id,user_id,status,comment,created_at) VALUES (?,?,?,?,?)').run(oid, user.id, 'new', 'Заявка создана', t);
    return oid;
  });
  return { id };
});

route('PATCH', '/api/orders/:id/status', ({ user, body, params }) => {
  requireRole(user);
  const id = int(params.id);
  const o = getOrder(user, id);
  const status = body.status || o.status;
  const comment = str(body.comment, 1000);
  if (!STATUSES[status]) fail(400, 'Неизвестный статус');
  if (!isStaff(user)) {
    // Мастер может только отменить свою новую заявку или оставить комментарий
    if (status !== o.status && !(status === 'cancelled' && o.status === 'new')) fail(403, 'Менять статус может только администратор или менеджер');
  }
  if (status === o.status && !comment) fail(400, 'Статус не изменился — добавьте комментарий');
  const t = now();
  tx(() => {
    q('UPDATE orders SET status=?, updated_at=? WHERE id=?').run(status, t, id);
    q('INSERT INTO order_history (order_id,user_id,status,comment,created_at) VALUES (?,?,?,?,?)')
      .run(id, user.id, status === o.status ? null : status, comment, t);
  });
  return getOrder(user, id);
});

route('DELETE', '/api/orders/:id', ({ user, params }) => {
  requireRole(user, 'admin');
  q('DELETE FROM orders WHERE id=?').run(int(params.id));
  return { ok: true };
});

/* ---- Статистика ---- */
route('GET', '/api/stats', ({ user }) => {
  requireRole(user);
  const own = !isStaff(user);
  const w = own ? 'WHERE user_id=?' : '';
  const a = own ? [user.id] : [];
  const byStatus = Object.fromEntries(Object.keys(STATUSES).map((k) => [k, 0]));
  q(`SELECT status, COUNT(*) c FROM orders ${w} GROUP BY status`).all(...a).forEach((r) => { byStatus[r.status] = r.c; });
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const month = q(`SELECT COUNT(*) c, COALESCE(SUM(total),0) s FROM orders ${w ? w + ' AND' : 'WHERE'} created_at>=? AND status<>'cancelled'`).get(...a, monthStart.toISOString());
  const active = q(`SELECT COALESCE(SUM(total),0) s FROM orders ${w ? w + ' AND' : 'WHERE'} status NOT IN ('done','cancelled')`).get(...a);
  return {
    byStatus, monthCount: month.c, monthSum: month.s, activeSum: active.s,
    parts: q('SELECT COUNT(*) c FROM parts WHERE active=1').get().c,
    pendingUsers: user.role === 'admin' ? q('SELECT COUNT(*) c FROM users WHERE active=0').get().c : 0,
    recent: listOrders(user, new URLSearchParams()).slice(0, 8),
  };
});

/* ---- Экспорт CSV ---- */
function csvExport(user, url, res) {
  requireRole(user, 'admin', 'manager');
  const rows = listOrders(user, url.searchParams);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['№', 'Создана', 'Сотрудник', 'Квитанция', 'Устройство', 'Детали', 'Приоритет', 'Статус', 'Сумма', 'Комментарий'].map(esc).join(';')];
  rows.forEach((o) => lines.push([o.id, new Date(o.created_at).toLocaleString('ru-RU', { timeZone: process.env.TZ || 'Europe/Moscow' }), o.user_name, o.ticket, o.device,
    o.items_names, PRIORITIES[o.priority], STATUSES[o.status], String(o.total).replace('.', ','), o.comment].map(esc).join(';')));
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="orders-${Date.now()}.csv"` });
  res.end('\uFEFF' + lines.join('\r\n'));
}

/* ---------------------------- Статика ---------------------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) file = path.join(PUBLIC_DIR, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
  });
}

/* ---------------------------- Сервер ---------------------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
  try {
    // Защита от CSRF: изменяющие запросы только с нашего же сайта
    if (req.method !== 'GET' && req.headers.origin && req.headers.host && new URL(req.headers.origin).host !== req.headers.host)
      fail(403, 'Запрос с чужого сайта отклонён');
    const user = currentUser(req);
    if (req.method === 'GET' && pathname === '/api/orders.csv') return csvExport(user, url, res);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = pathname.match(r.re);
      if (!m) continue;
      const params = {}; r.keys.forEach((k, i) => { params[k] = m[i + 1]; });
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
      const result = await r.handler({ req, res, url, user, body, params });
      return send(res, 200, result);
    }
    fail(404, 'Не найдено');
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.code, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Внутренняя ошибка сервера' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`✔ Сервисный центр запущен: http://localhost:${PORT}`);
  console.log(`  База данных: ${path.join(DATA_DIR, 'service.db')}`);
  if (q('SELECT COUNT(*) c FROM users').get().c === 0) console.log('  Первый зарегистрированный пользователь станет администратором.');
});
