'use strict';
/* ====================== Утилиты ====================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 }).format(Number(n) || 0);
const dt = (iso) => iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const ago = (iso) => {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'только что'; if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`; return `${Math.floor(s / 86400)} дн назад`;
};
const initials = (n) => String(n || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET', credentials: 'same-origin',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.user && !path.startsWith('/api/auth')) { state.user = null; render(); }
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data;
}
function toast(msg, err = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : ''); el.textContent = msg;
  $('#toasts').append(el); setTimeout(() => el.remove(), 3800);
}
const handle = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

function modal(html, onMount) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-bg"><div class="modal">${html}</div></div>`;
  const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  $('.modal-bg', root).addEventListener('mousedown', (e) => { if (e.target.classList.contains('modal-bg')) close(); });
  $$('[data-close]', root).forEach((b) => b.addEventListener('click', close));
  onMount && onMount($('.modal', root), close);
  return close;
}
function confirmBox(text) {
  return new Promise((resolve) => {
    modal(`<h2>Подтвердите действие</h2><p class="muted">${esc(text)}</p>
      <div class="row" style="justify-content:flex-end;margin-top:20px"><button class="btn" data-close>Отмена</button><button class="btn danger" id="cf-yes">Подтвердить</button></div>`,
    (m, close) => { $('#cf-yes', m).onclick = () => { close(); resolve(true); }; $$('[data-close]', m).forEach((b) => b.addEventListener('click', () => resolve(false))); });
  });
}
const formData = (form) => Object.fromEntries(new FormData(form).entries());

/* ====================== Состояние ====================== */
const state = { user: null, meta: { statuses: {}, priorities: {}, roles: {} }, pendingUsers: 0 };
const cart = {
  get() { try { return JSON.parse(localStorage.getItem('cart') || '[]'); } catch { return []; } },
  set(v) { localStorage.setItem('cart', JSON.stringify(v)); updateCartBadge(); },
  add(part) {
    const c = this.get(); const f = c.find((i) => i.part_id === part.id);
    if (f) f.qty++; else c.push({ part_id: part.id, name: part.name, sku: part.sku, price: part.price, qty: 1 });
    this.set(c);
  },
};
const isStaff = () => state.user && ['admin', 'manager'].includes(state.user.role);
const isAdmin = () => state.user && state.user.role === 'admin';
const statusBadge = (s) => `<span class="badge s-${esc(s)}">${esc(state.meta.statuses[s] || s)}</span>`;
const prioLabel = (p) => `<span class="p-${esc(p)}">${p === 'urgent' ? '🔥 ' : ''}${esc(state.meta.priorities[p] || p)}</span>`;
const statusOptions = (cur, extra = '') => `${extra}${Object.entries(state.meta.statuses).map(([k, v]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${esc(v)}</option>`).join('')}`;

/* ====================== Роутинг ====================== */
const routes = [
  [/^\/?$/, pageDashboard], [/^\/orders$/, pageOrders], [/^\/orders\/new$/, pageNewOrder], [/^\/orders\/(\d+)$/, pageOrder],
  [/^\/parts$/, pageParts], [/^\/users$/, pageUsers], [/^\/profile$/, pageProfile],
];
const go = (h) => { location.hash = '#' + h; };
window.addEventListener('hashchange', () => render());

async function boot() {
  try { state.meta = await api('/api/meta'); const me = await api('/api/auth/me'); state.user = me.user; } catch (e) { console.error(e); }
  render();
}

function render() {
  if (!state.user) return renderAuth();
  const hash = location.hash.replace(/^#/, '') || '/';
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) { renderLayout(hash); return handle(fn)(...m.slice(1)); }
  }
  go('/');
}

/* ====================== Авторизация ====================== */
function renderAuth(tab = 'login') {
  $('#app').innerHTML = `
  <div class="auth">
    <div class="auth-hero">
      <div class="brand" style="padding:0"><div class="logo">🛠️</div>FixHub</div>
      <h1>Заявки на запчасти<br><span style="background:linear-gradient(90deg,var(--accent),var(--accent2));-webkit-background-clip:text;color:transparent">для сервисного центра</span></h1>
      <p class="muted" style="max-width:460px">Единая система для мастеров и закупщиков: каталог деталей с вашими ценами, заявки с полной историей и статусами.</p>
      <div class="feat">📦 <span><b>Свой каталог</b> — детали, артикулы, совместимость, цены</span></div>
      <div class="feat">🧾 <span><b>Заявки</b> — кто оформил, когда, для какого устройства</span></div>
      <div class="feat">🔄 <span><b>Статусы</b> — от «Новая» до «Куплено» и «Выполнено»</span></div>
      <div class="feat">🛡️ <span><b>Админ-панель</b> — сотрудники, роли, подтверждение доступа</span></div>
    </div>
    <div class="auth-box"><div class="auth-card card">
      <div class="tabs"><button data-tab="login" class="${tab === 'login' ? 'on' : ''}">Вход</button><button data-tab="register" class="${tab === 'register' ? 'on' : ''}">Регистрация</button></div>
      ${tab === 'login' ? `
      <form id="f-auth">
        <div class="field"><label>Email</label><input name="email" type="email" required autocomplete="username" autofocus></div>
        <div class="field"><label>Пароль</label><input name="password" type="password" required autocomplete="current-password"></div>
        <button class="btn primary" style="width:100%">Войти</button>
      </form>` : `
      <form id="f-auth">
        <div class="field"><label>Имя и фамилия</label><input name="name" required minlength="2" autofocus></div>
        <div class="field"><label>Email</label><input name="email" type="email" required autocomplete="username"></div>
        <div class="field"><label>Телефон (необязательно)</label><input name="phone" type="tel"></div>
        <div class="field"><label>Пароль (минимум 6 символов)</label><input name="password" type="password" required minlength="6" autocomplete="new-password"></div>
        <div class="field"><label>Повторите пароль</label><input name="password2" type="password" required minlength="6" autocomplete="new-password"></div>
        <button class="btn primary" style="width:100%">Зарегистрироваться</button>
        <p class="small muted" style="margin-bottom:0">Новые аккаунты активирует администратор. Первый зарегистрированный пользователь автоматически становится администратором.</p>
      </form>`}
    </div></div>
  </div>`;
  $$('[data-tab]').forEach((b) => b.onclick = () => renderAuth(b.dataset.tab));
  $('#f-auth').onsubmit = handle(async (e) => {
    e.preventDefault(); const d = formData(e.target);
    if (tab === 'register') {
      if (d.password !== d.password2) throw new Error('Пароли не совпадают');
      const r = await api('/api/auth/register', { method: 'POST', body: d });
      toast(r.message); renderAuth('login'); $('[name=email]').value = d.email; return;
    }
    await api('/api/auth/login', { method: 'POST', body: d });
    state.user = (await api('/api/auth/me')).user; go('/'); render();
  });
}

/* ====================== Каркас ====================== */
function renderLayout(hash) {
  const u = state.user;
  const link = (h, icon, text, extra = '') => `<a href="#${h}" class="${(hash === h || (h !== '/' && hash.startsWith(h) && !(h === '/orders' && hash === '/orders/new'))) ? 'active' : ''}">${icon} ${text}${extra}</a>`;
  $('#app').innerHTML = `
  <div class="layout">
    <aside class="sidebar" id="sidebar">
      <div class="brand"><div class="logo">🛠️</div>FixHub</div>
      <nav class="nav">
        ${link('/', '📊', 'Обзор')}
        ${link('/orders', '🧾', isStaff() ? 'Все заявки' : 'Мои заявки')}
        ${link('/orders/new', '➕', 'Новая заявка', '<span class="count" id="cart-badge" style="background:var(--accent)"></span>')}
        ${link('/parts', '📦', 'Каталог запчастей')}
        ${isAdmin() ? `<div class="sep">Администрирование</div>${link('/users', '👥', 'Сотрудники', state.pendingUsers ? `<span class="count">${state.pendingUsers}</span>` : '')}` : ''}
        <div class="sep">Аккаунт</div>
        ${link('/profile', '⚙️', 'Профиль')}
      </nav>
      <div class="side-user"><div class="row" style="gap:10px;flex-wrap:nowrap"><div class="avatar">${esc(initials(u.name))}</div>
        <div class="grow" style="min-width:0"><div class="ellipsis" style="font-weight:600">${esc(u.name)}</div><div class="small muted">${esc(state.meta.roles[u.role])}</div></div>
        <button class="icon-btn" id="logout" title="Выйти">⎋</button></div></div>
    </aside>
    <button class="btn burger" id="burger" style="position:fixed;top:12px;right:12px;z-index:45">☰</button>
    <main class="main" id="main"><div class="muted">Загрузка…</div></main>
  </div>`;
  $('#logout').onclick = handle(async () => { await api('/api/auth/logout', { method: 'POST' }); state.user = null; location.hash = ''; render(); });
  $('#burger').onclick = () => $('#sidebar').classList.toggle('open');
  updateCartBadge();
}
function updateCartBadge() {
  const b = $('#cart-badge'); if (!b) return;
  const n = cart.get().reduce((s, i) => s + i.qty, 0);
  b.textContent = n || ''; b.style.display = n ? '' : 'none';
}
const setMain = (html) => { const m = $('#main'); m.innerHTML = html; return m; };
const head = (title, sub = '', actions = '') => `<div class="page-head"><div><h1>${title}</h1>${sub ? `<div class="muted">${sub}</div>` : ''}</div><div class="row">${actions}</div></div>`;

function ordersTable(rows, { inlineStatus = false, showUser = true } = {}) {
  if (!rows.length) return `<div class="table-wrap"><div class="empty">Заявок пока нет</div></div>`;
  return `<div class="table-wrap"><table><thead><tr>
    <th>№</th><th>Оформлена</th>${showUser ? '<th>Сотрудник</th>' : ''}<th>Устройство / квитанция</th><th>Детали</th><th class="right">Сумма</th><th>Приоритет</th><th>Статус</th>
  </tr></thead><tbody>
  ${rows.map((o) => `<tr class="click" data-id="${o.id}">
    <td class="nowrap"><b>#${o.id}</b></td>
    <td class="nowrap">${dt(o.created_at)}<div class="sub">${ago(o.created_at)}</div></td>
    ${showUser ? `<td class="nowrap">${esc(o.user_name)}</td>` : ''}
    <td>${esc(o.device) || '<span class="dim">—</span>'}${o.ticket ? `<div class="sub">Квитанция: ${esc(o.ticket)}</div>` : ''}</td>
    <td><div class="ellipsis" title="${esc(o.items_names)}">${esc(o.items_names)}</div><div class="sub">${o.items_count} поз.</div></td>
    <td class="right nowrap"><b>${money(o.total)}</b></td>
    <td class="nowrap">${prioLabel(o.priority)}</td>
    <td>${inlineStatus ? `<select class="status-select s-${o.status}" data-status="${o.id}">${statusOptions(o.status)}</select>` : statusBadge(o.status)}</td>
  </tr>`).join('')}</tbody></table></div>`;
}
function bindOrdersTable(root, reload) {
  $$('tr[data-id]', root).forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('select')) go('/orders/' + tr.dataset.id); }));
  $$('select[data-status]', root).forEach((sel) => {
    const prev = sel.value;
    sel.addEventListener('change', handle(async () => {
      try {
        await api(`/api/orders/${sel.dataset.status}/status`, { method: 'PATCH', body: { status: sel.value } });
        sel.className = `status-select s-${sel.value}`; toast(`Заявка #${sel.dataset.status}: ${state.meta.statuses[sel.value]}`);
        reload && reload();
      } catch (e) { sel.value = prev; throw e; }
    }));
  });
}

/* ====================== Обзор ====================== */
async function pageDashboard() {
  const s = await api('/api/stats');
  state.pendingUsers = s.pendingUsers;
  const st = s.byStatus;
  const card = (label, v, c, link) => `<a href="#${link || '/orders'}" class="card stat" style="--c:${c};color:inherit"><div class="l">${label}</div><div class="v">${v}</div></a>`;
  const m = setMain(`
    ${head(`Здравствуйте, ${esc(state.user.name.split(' ')[0])} 👋`, isStaff() ? 'Сводка по всем заявкам сервисного центра' : 'Сводка по вашим заявкам', `<a class="btn primary" href="#/orders/new">➕ Новая заявка</a>`)}
    ${s.pendingUsers ? `<div class="alert" style="margin-bottom:16px">👥 Ожидают подтверждения: <b>${s.pendingUsers}</b> сотрудник(ов). <a href="#/users">Перейти →</a></div>` : ''}
    <div class="grid g4" style="margin-bottom:16px">
      ${card('Новые', st.new, 'var(--info)')}
      ${card('В работе (обработка / заказано)', st.processing + st.ordered, 'var(--warn)')}
      ${card('Куплено / получено', st.purchased + st.received, 'var(--accent2)')}
      ${card('Выполнено', st.done, 'var(--ok)')}
    </div>
    <div class="grid g4" style="margin-bottom:24px">
      ${card('Заявок в этом месяце', s.monthCount, 'var(--accent)')}
      ${card('Сумма за месяц', money(s.monthSum), 'var(--accent)')}
      ${card('Сумма активных заявок', money(s.activeSum), 'var(--warn)')}
      ${card('Деталей в каталоге', s.parts, 'var(--accent2)', '/parts')}
    </div>
    <div class="row space" style="margin-bottom:12px"><h2 style="margin:0">Последние заявки</h2><a href="#/orders">Все заявки →</a></div>
    <div id="recent">${ordersTable(s.recent, { inlineStatus: isStaff(), showUser: isStaff() })}</div>`);
  bindOrdersTable(m, () => {});
}

/* ====================== Список заявок ====================== */
async function pageOrders() {
  const f = JSON.parse(sessionStorage.getItem('orderFilters') || '{}');
  const m = setMain(`
    ${head(isStaff() ? 'Все заявки' : 'Мои заявки', 'Нажмите на строку, чтобы открыть заявку', `${isStaff() ? '<button class="btn" id="csv">⬇ Экспорт в Excel (CSV)</button>' : ''}<a class="btn primary" href="#/orders/new">➕ Новая заявка</a>`)}
    <div class="card" style="margin-bottom:16px;padding:14px"><form id="filters" class="row">
      <input name="q" placeholder="🔍 Поиск: №, устройство, квитанция, деталь, сотрудник" class="grow" style="min-width:240px" value="${esc(f.q || '')}">
      <select name="status" style="width:220px"><option value="">Все статусы</option><option value="active" ${f.status === 'active' ? 'selected' : ''}>Только активные</option>${Object.entries(state.meta.statuses).map(([k, v]) => `<option value="${k}" ${f.status === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
      <input type="date" name="from" style="width:160px" value="${esc(f.from || '')}" title="С даты">
      <input type="date" name="to" style="width:160px" value="${esc(f.to || '')}" title="По дату">
      ${isStaff() ? `<label class="row small" style="margin:0;gap:6px;cursor:pointer"><input type="checkbox" name="mine" value="1" style="width:auto" ${f.mine ? 'checked' : ''}> Только мои</label>` : ''}
      <button type="button" class="btn ghost" id="reset">Сбросить</button>
    </form></div>
    <div id="list"><div class="muted">Загрузка…</div></div>`);
  const form = $('#filters', m);
  const params = () => { const d = formData(form); Object.keys(d).forEach((k) => !d[k] && delete d[k]); return d; };
  const load = handle(async () => {
    const p = params(); sessionStorage.setItem('orderFilters', JSON.stringify(p));
    const rows = await api('/api/orders?' + new URLSearchParams(p));
    const total = rows.reduce((s, o) => s + (o.status === 'cancelled' ? 0 : o.total), 0);
    $('#list', m).innerHTML = `<div class="small muted" style="margin-bottom:8px">Найдено: ${rows.length} · Сумма (без отменённых): ${money(total)}</div>` + ordersTable(rows, { inlineStatus: isStaff(), showUser: isStaff() });
    bindOrdersTable($('#list', m));
  });
  let t; form.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
  form.addEventListener('submit', (e) => { e.preventDefault(); load(); });
  $('#reset', m).onclick = () => { form.reset(); $$('input,select', form).forEach((i) => { if (i.type === 'checkbox') i.checked = false; else i.value = ''; }); load(); };
  const csv = $('#csv', m); if (csv) csv.onclick = () => { location.href = '/api/orders.csv?' + new URLSearchParams(params()); };
  load();
}

/* ====================== Заявка ====================== */
async function pageOrder(id) {
  const o = await api('/api/orders/' + id);
  const canCancel = !isStaff() && o.user_id === state.user.id && o.status === 'new';
  const m = setMain(`
    ${head(`Заявка #${o.id} ${statusBadge(o.status)}`, `Оформлена ${dt(o.created_at)} · ${esc(o.user_name)}`, `<a class="btn ghost" href="#/orders">← К списку</a><button class="btn" id="print">🖨 Печать</button>${isAdmin() ? '<button class="btn danger" id="del">Удалить</button>' : ''}`)}
    <div class="grid" style="grid-template-columns:minmax(0,2fr) minmax(280px,1fr);align-items:start">
      <div class="grid">
        <div class="card"><h2>Информация</h2><div class="kv">
          <div>Кто оформил</div><div><b>${esc(o.user_name)}</b> <span class="muted small">${esc(o.user_email)}</span></div>
          <div>Дата и время</div><div>${dt(o.created_at)} <span class="muted small">(${ago(o.created_at)})</span></div>
          <div>Последнее изменение</div><div>${dt(o.updated_at)}</div>
          <div>Устройство</div><div>${esc(o.device) || '—'}</div>
          <div>№ квитанции / ремонта</div><div>${esc(o.ticket) || '—'}</div>
          <div>Приоритет</div><div>${prioLabel(o.priority)}</div>
          <div>Комментарий</div><div style="white-space:pre-wrap">${esc(o.comment) || '—'}</div>
        </div></div>
        <div class="card" style="padding:0;overflow:hidden"><div style="padding:18px 18px 8px"><h2>Детали</h2></div>
          <table><thead><tr><th>Наименование</th><th>Артикул</th><th class="right">Цена</th><th class="right">Кол-во</th><th class="right">Сумма</th></tr></thead><tbody>
          ${o.items.map((i) => `<tr><td>${esc(i.name)} ${i.part_id ? '' : '<span class="chip">не из каталога</span>'}</td><td class="muted">${esc(i.sku) || '—'}</td><td class="right nowrap">${money(i.price)}</td><td class="right">${i.qty}</td><td class="right nowrap"><b>${money(i.price * i.qty)}</b></td></tr>`).join('')}
          <tr><td colspan="4" class="right muted">Итого</td><td class="right total nowrap">${money(o.total)}</td></tr></tbody></table>
        </div>
      </div>
      <div class="grid">
        <div class="card"><h2>${isStaff() ? 'Сменить статус' : 'Действия'}</h2>
          <form id="f-status">
            ${isStaff() ? `<div class="field"><label>Статус</label><select name="status">${statusOptions(o.status)}</select></div>
              <div class="row" style="gap:6px;margin-bottom:14px">${['processing', 'ordered', 'purchased', 'received', 'done'].filter((s) => s !== o.status).map((s) => `<button type="button" class="btn sm" data-quick="${s}">${esc(state.meta.statuses[s])}</button>`).join('')}</div>` : ''}
            <div class="field"><label>Комментарий ${isStaff() ? '(необязательно)' : ''}</label><textarea name="comment" placeholder="Например: заказано у поставщика, ожидаем 3 дня"></textarea></div>
            <div class="row"><button class="btn primary">${isStaff() ? 'Сохранить' : 'Добавить комментарий'}</button>${canCancel ? '<button type="button" class="btn danger" id="cancel">Отменить заявку</button>' : ''}</div>
          </form>
        </div>
        <div class="card"><h2>История</h2><div class="timeline">
          ${o.history.slice().reverse().map((h) => `<div class="tl"><div class="t">${dt(h.created_at)} · ${esc(h.user_name || 'удалённый пользователь')}</div>
            ${h.status ? `<div style="margin:4px 0">${statusBadge(h.status)}</div>` : ''}${h.comment ? `<div style="white-space:pre-wrap">${esc(h.comment)}</div>` : ''}</div>`).join('')}
        </div></div>
      </div>
    </div>`);
  const f = $('#f-status', m);
  const submit = async (status) => {
    const d = formData(f);
    await api(`/api/orders/${o.id}/status`, { method: 'PATCH', body: { status: status || d.status, comment: d.comment } });
    toast('Заявка обновлена'); pageOrder(o.id);
  };
  f.onsubmit = handle(async (e) => { e.preventDefault(); await submit(); });
  $$('[data-quick]', m).forEach((b) => b.onclick = handle(() => submit(b.dataset.quick)));
  const c = $('#cancel', m); if (c) c.onclick = handle(async () => { if (await confirmBox('Отменить эту заявку?')) await submit('cancelled'); });
  const d = $('#del', m); if (d) d.onclick = handle(async () => { if (!(await confirmBox(`Удалить заявку #${o.id} безвозвратно?`))) return; await api('/api/orders/' + o.id, { method: 'DELETE' }); toast('Заявка удалена'); go('/orders'); });
  $('#print', m).onclick = () => printOrder(o);
}
function printOrder(o) {
  const w = window.open('', '_blank');
  w.document.write(`<html><head><meta charset="utf-8"><title>Заявка #${o.id}</title><style>body{font-family:Arial;padding:30px;color:#111}table{width:100%;border-collapse:collapse;margin-top:16px}td,th{border:1px solid #999;padding:6px 8px;text-align:left}.r{text-align:right}</style></head><body>
    <h2>Заявка на запчасти #${o.id}</h2>
    <p>Оформил: <b>${esc(o.user_name)}</b><br>Дата: ${dt(o.created_at)}<br>Устройство: ${esc(o.device) || '—'}<br>Квитанция: ${esc(o.ticket) || '—'}<br>Статус: ${esc(state.meta.statuses[o.status])}<br>Приоритет: ${esc(state.meta.priorities[o.priority])}<br>Комментарий: ${esc(o.comment) || '—'}</p>
    <table><tr><th>Наименование</th><th>Артикул</th><th class="r">Цена</th><th class="r">Кол-во</th><th class="r">Сумма</th></tr>
    ${o.items.map((i) => `<tr><td>${esc(i.name)}</td><td>${esc(i.sku)}</td><td class="r">${money(i.price)}</td><td class="r">${i.qty}</td><td class="r">${money(i.price * i.qty)}</td></tr>`).join('')}
    <tr><td colspan="4" class="r"><b>Итого</b></td><td class="r"><b>${money(o.total)}</b></td></tr></table>
    <script>window.onload=()=>window.print()<\/script></body></html>`);
  w.document.close();
}

/* ====================== Новая заявка ====================== */
async function pageNewOrder() {
  const m = setMain(`
    ${head('Новая заявка на запчасти', 'Выберите детали из каталога или добавьте позицию вручную')}
    <div class="grid" style="grid-template-columns:minmax(0,1.2fr) minmax(320px,1fr);align-items:start">
      <div class="card"><h2>Каталог</h2>
        <div class="row" style="margin-bottom:12px"><input id="ps" placeholder="🔍 Название, артикул, бренд, модель устройства" class="grow"><select id="pc" style="width:180px"><option value="">Все категории</option></select></div>
        <div id="plist" style="max-height:520px;overflow:auto"></div>
        <details style="margin-top:14px"><summary style="cursor:pointer;color:var(--accent2)">➕ Детали нет в каталоге? Добавить вручную</summary>
          <form id="f-custom" class="row" style="margin-top:12px;align-items:flex-end">
            <div class="grow" style="min-width:200px"><label>Название</label><input name="name" required minlength="2"></div>
            <div style="width:130px"><label>Артикул</label><input name="sku"></div>
            <div style="width:120px"><label>Цена, ₽</label><input name="price" type="number" min="0" step="0.01" value="0"></div>
            <button class="btn">Добавить</button>
          </form></details>
      </div>
      <div class="card" style="position:sticky;top:20px"><h2>Заявка</h2>
        <form id="f-order">
          <div id="cart"></div>
          <div class="field"><label>Устройство (модель)</label><input name="device" placeholder="Например: Samsung Galaxy A52, ноутбук Lenovo IdeaPad 3"></div>
          <div class="row" style="flex-wrap:nowrap">
            <div class="field grow"><label>№ квитанции / ремонта</label><input name="ticket" placeholder="R-1024"></div>
            <div class="field grow"><label>Приоритет</label><select name="priority">${Object.entries(state.meta.priorities).map(([k, v]) => `<option value="${k}" ${k === 'normal' ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
          </div>
          <div class="field"><label>Комментарий</label><textarea name="comment" placeholder="Цвет, ревизия, сроки, ссылка на поставщика…"></textarea></div>
          <button class="btn primary" style="width:100%" id="submit">Оформить заявку</button>
        </form>
      </div>
    </div>`);
  const cats = await api('/api/parts/categories');
  $('#pc', m).innerHTML += cats.map((c) => `<option>${esc(c)}</option>`).join('');
  const renderCart = () => {
    const c = cart.get(); const total = c.reduce((s, i) => s + i.price * i.qty, 0);
    $('#cart', m).innerHTML = c.length ? `<div class="table-wrap" style="margin-bottom:14px"><table><tbody>${c.map((i, idx) => `<tr>
      <td>${esc(i.name)}${i.part_id ? '' : ' <span class="chip">вручную</span>'}<div class="sub">${money(i.price)} / шт.</div></td>
      <td><input type="number" class="qty" min="1" max="9999" value="${i.qty}" data-qty="${idx}"></td>
      <td class="right nowrap">${money(i.price * i.qty)}</td><td><button type="button" class="icon-btn" data-rm="${idx}" title="Убрать">✕</button></td></tr>`).join('')}
      <tr><td colspan="2" class="right muted">Итого</td><td class="right total nowrap" colspan="2">${money(total)}</td></tr></tbody></table></div>`
      : `<div class="empty" style="padding:24px;border:1px dashed var(--line2);border-radius:12px;margin-bottom:14px">Корзина пуста — добавьте детали слева</div>`;
    $$('[data-qty]', m).forEach((inp) => inp.onchange = () => { const v = cart.get(); v[inp.dataset.qty].qty = Math.max(1, parseInt(inp.value) || 1); cart.set(v); renderCart(); });
    $$('[data-rm]', m).forEach((b) => b.onclick = () => { const v = cart.get(); v.splice(b.dataset.rm, 1); cart.set(v); renderCart(); });
    $('#submit', m).disabled = !c.length;
  };
  const loadParts = handle(async () => {
    const rows = await api('/api/parts?' + new URLSearchParams({ q: $('#ps', m).value, category: $('#pc', m).value }));
    $('#plist', m).innerHTML = rows.length ? `<table><tbody>${rows.map((p) => `<tr>
      <td>${esc(p.name)}<div class="sub">${[p.sku && 'Арт. ' + p.sku, p.brand, p.compatible].filter(Boolean).map(esc).join(' · ')}</div></td>
      <td class="nowrap">${p.category ? `<span class="chip">${esc(p.category)}</span>` : ''}</td>
      <td class="right nowrap"><b>${money(p.price)}</b><div class="sub">${p.stock > 0 ? `в наличии: ${p.stock}` : 'нет в наличии'}</div></td>
      <td><button type="button" class="btn sm primary" data-add="${p.id}">+</button></td></tr>`).join('')}</tbody></table>`
      : `<div class="empty">Ничего не найдено${isStaff() ? ' — <a href="#/parts">добавьте детали в каталог</a>' : ''}</div>`;
    $$('[data-add]', m).forEach((b) => b.onclick = () => { cart.add(rows.find((p) => p.id == b.dataset.add)); renderCart(); toast('Добавлено в заявку'); });
  });
  let t; $('#ps', m).oninput = () => { clearTimeout(t); t = setTimeout(loadParts, 200); }; $('#pc', m).onchange = loadParts;
  $('#f-custom', m).onsubmit = (e) => {
    e.preventDefault(); const d = formData(e.target); const v = cart.get();
    v.push({ part_id: null, name: d.name.trim(), sku: d.sku.trim(), price: Math.max(0, parseFloat(String(d.price).replace(',', '.')) || 0), qty: 1 });
    cart.set(v); e.target.reset(); renderCart();
  };
  $('#f-order', m).onsubmit = handle(async (e) => {
    e.preventDefault(); const btn = $('#submit', m); btn.disabled = true;
    try {
      const r = await api('/api/orders', { method: 'POST', body: { ...formData(e.target), items: cart.get() } });
      cart.set([]); toast(`Заявка #${r.id} оформлена`); go('/orders/' + r.id);
    } finally { btn.disabled = false; }
  });
  renderCart(); loadParts();
}

/* ====================== Каталог ====================== */
async function pageParts() {
  const staff = isStaff();
  const m = setMain(`
    ${head('Каталог запчастей', staff ? 'Ваши детали и цены — доступны всем сотрудникам при оформлении заявки' : 'Нажмите «+», чтобы добавить деталь в заявку', staff ? '<button class="btn" id="import">⬆ Импорт CSV</button><button class="btn primary" id="add">➕ Добавить деталь</button>' : '<a class="btn primary" href="#/orders/new">Перейти к заявке</a>')}
    <div class="card" style="margin-bottom:16px;padding:14px"><div class="row">
      <input id="ps" placeholder="🔍 Название, артикул, бренд, совместимость" class="grow" style="min-width:240px">
      <select id="pc" style="width:200px"><option value="">Все категории</option></select>
      ${staff ? '<label class="row small" style="margin:0;gap:6px;cursor:pointer"><input type="checkbox" id="pall" style="width:auto"> Показать скрытые</label>' : ''}
    </div></div>
    <div id="list"></div>`);
  const loadCats = async () => { const cats = await api('/api/parts/categories'); $('#pc', m).innerHTML = '<option value="">Все категории</option>' + cats.map((c) => `<option>${esc(c)}</option>`).join(''); };
  const load = handle(async () => {
    const rows = await api('/api/parts?' + new URLSearchParams({ q: $('#ps', m).value, category: $('#pc', m).value, all: $('#pall', m)?.checked ? '1' : '' }));
    $('#list', m).innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>Наименование</th><th>Категория</th><th>Совместимость</th>${staff ? '<th>Поставщик</th>' : ''}<th class="right">Закупка</th><th class="right">Для клиента</th><th class="right">Наличие</th><th></th></tr></thead><tbody>
      ${rows.map((p) => `<tr style="${p.active ? '' : 'opacity:.5'}">
        <td><b>${esc(p.name)}</b><div class="sub">${[p.sku && 'Арт. ' + p.sku, p.brand].filter(Boolean).map(esc).join(' · ') || '&nbsp;'}</div></td>
        <td>${p.category ? `<span class="chip">${esc(p.category)}</span>` : '—'}</td>
        <td class="muted"><div class="ellipsis" title="${esc(p.compatible)}">${esc(p.compatible) || '—'}</div></td>
        ${staff ? `<td class="muted">${esc(p.supplier) || '—'}</td>` : ''}
        <td class="right nowrap"><b>${money(p.price)}</b></td>
        <td class="right nowrap muted">${p.sale_price ? money(p.sale_price) : '—'}</td>
        <td class="right">${p.stock}</td>
        <td class="nowrap right">${p.active ? `<button class="btn sm primary" data-cart="${p.id}" title="В заявку">+</button>` : '<span class="chip">скрыта</span>'}
          ${staff ? `<button class="icon-btn" data-edit="${p.id}" title="Редактировать">✎</button><button class="icon-btn" data-del="${p.id}" title="Удалить">🗑</button>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>`
      : `<div class="table-wrap"><div class="empty">Каталог пуст${staff ? '. Нажмите «Добавить деталь» или импортируйте CSV' : ''}</div></div>`;
    $$('[data-cart]', m).forEach((b) => b.onclick = () => { cart.add(rows.find((p) => p.id == b.dataset.cart)); toast('Добавлено в заявку'); });
    $$('[data-edit]', m).forEach((b) => b.onclick = () => partModal(rows.find((p) => p.id == b.dataset.edit), reload));
    $$('[data-del]', m).forEach((b) => b.onclick = handle(async () => {
      const p = rows.find((x) => x.id == b.dataset.del);
      if (!(await confirmBox(`Удалить «${p.name}»? Если деталь уже есть в заявках, она будет скрыта из каталога.`))) return;
      const r = await api('/api/parts/' + p.id, { method: 'DELETE' }); toast(r.archived ? 'Деталь скрыта (используется в заявках)' : 'Деталь удалена'); reload();
    }));
  });
  const reload = async () => { await loadCats().catch(() => {}); load(); };
  let t; $('#ps', m).oninput = () => { clearTimeout(t); t = setTimeout(load, 200); }; $('#pc', m).onchange = load;
  if ($('#pall', m)) $('#pall', m).onchange = load;
  if (staff) { $('#add', m).onclick = () => partModal(null, reload); $('#import', m).onclick = () => importModal(reload); }
  reload();
}
function partModal(p, done) {
  const v = p || { active: 1 };
  modal(`<h2>${p ? 'Редактировать деталь' : 'Новая деталь'}</h2>
    <form id="f-part">
      <div class="field"><label>Наименование *</label><input name="name" required minlength="2" value="${esc(v.name)}" placeholder="Дисплей в сборе iPhone 11, черный"></div>
      <div class="grid g2" style="gap:0 14px;grid-template-columns:1fr 1fr">
        <div class="field"><label>Артикул</label><input name="sku" value="${esc(v.sku)}"></div>
        <div class="field"><label>Категория</label><input name="category" list="cat-list" value="${esc(v.category)}" placeholder="Дисплеи, АКБ, Платы…"><datalist id="cat-list"></datalist></div>
        <div class="field"><label>Бренд / производитель</label><input name="brand" value="${esc(v.brand)}"></div>
        <div class="field"><label>Поставщик</label><input name="supplier" value="${esc(v.supplier)}"></div>
        <div class="field"><label>Цена закупки, ₽ *</label><input name="price" type="number" min="0" step="0.01" required value="${v.price ?? ''}"></div>
        <div class="field"><label>Цена для клиента, ₽</label><input name="sale_price" type="number" min="0" step="0.01" value="${v.sale_price ?? ''}"></div>
        <div class="field"><label>В наличии, шт.</label><input name="stock" type="number" min="0" step="1" value="${v.stock ?? 0}"></div>
        <div class="field"><label>Видимость</label><select name="active"><option value="1" ${v.active ? 'selected' : ''}>Показывать в каталоге</option><option value="0" ${!v.active ? 'selected' : ''}>Скрыть</option></select></div>
      </div>
      <div class="field"><label>Совместимые устройства</label><input name="compatible" value="${esc(v.compatible)}" placeholder="iPhone 11, A2111, A2221"></div>
      <div class="field"><label>Описание</label><textarea name="description">${esc(v.description)}</textarea></div>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Отмена</button><button class="btn primary">Сохранить</button></div>
    </form>`, async (mm, close) => {
    api('/api/parts/categories').then((c) => { $('#cat-list', mm).innerHTML = c.map((x) => `<option value="${esc(x)}">`).join(''); }).catch(() => {});
    $('#f-part', mm).onsubmit = handle(async (e) => {
      e.preventDefault(); const d = formData(e.target); d.active = d.active === '1';
      await api(p ? '/api/parts/' + p.id : '/api/parts', { method: p ? 'PUT' : 'POST', body: d });
      close(); toast(p ? 'Деталь обновлена' : 'Деталь добавлена'); done();
    });
  });
}
function parseCSV(text) {
  const sep = (text.split('\n')[0].match(/;/g) || []).length >= (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') inQ = false; else cell += ch; }
    else if (ch === '"') inQ = true; else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}
function importModal(done) {
  modal(`<h2>Импорт деталей из CSV / Excel</h2>
    <p class="muted">Сохраните таблицу Excel как «CSV (разделители — точка с запятой)». Первая строка — заголовки. Колонки:</p>
    <p><code class="chip">Наименование; Артикул; Категория; Бренд; Совместимость; Поставщик; Цена; Цена для клиента; Наличие</code></p>
    <div class="field"><input type="file" id="csvfile" accept=".csv,text/csv"></div>
    <div id="preview" class="small muted"></div>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn" data-close>Отмена</button><button class="btn primary" id="go" disabled>Импортировать</button></div>`,
  (mm, close) => {
    let items = [];
    $('#csvfile', mm).onchange = async (e) => {
      const rows = parseCSV((await e.target.files[0].text()).replace(/^\uFEFF/, ''));
      items = rows.slice(1).map((r) => ({ name: r[0], sku: r[1], category: r[2], brand: r[3], compatible: r[4], supplier: r[5], price: r[6], sale_price: r[7], stock: r[8] })).filter((i) => i.name && i.name.trim().length >= 2);
      $('#preview', mm).textContent = `Найдено позиций: ${items.length}`; $('#go', mm).disabled = !items.length;
    };
    $('#go', mm).onclick = handle(async () => {
      $('#go', mm).disabled = true; let ok = 0, bad = 0;
      for (const it of items) { try { await api('/api/parts', { method: 'POST', body: it }); ok++; } catch { bad++; } }
      close(); toast(`Импортировано: ${ok}${bad ? `, ошибок: ${bad}` : ''}`); done();
    });
  });
}

/* ====================== Сотрудники ====================== */
async function pageUsers() {
  if (!isAdmin()) return go('/');
  const rows = await api('/api/users');
  state.pendingUsers = rows.filter((u) => !u.active).length;
  const m = setMain(`
    ${head('Сотрудники', 'Подтверждение регистраций, роли и доступ', '<button class="btn primary" id="add">➕ Добавить сотрудника</button>')}
    <div class="card small muted" style="margin-bottom:16px;padding:14px">
      <b style="color:var(--text)">Роли:</b> <b>Мастер</b> — оформляет заявки и видит только свои; <b>Менеджер закупок</b> — видит все заявки, меняет статусы, ведёт каталог; <b>Администратор</b> — всё, плюс управление сотрудниками и удаление заявок.
    </div>
    <div class="table-wrap"><table><thead><tr><th>Сотрудник</th><th>Контакты</th><th>Зарегистрирован</th><th>Заявок</th><th>Роль</th><th>Доступ</th><th></th></tr></thead><tbody>
    ${rows.map((u) => `<tr>
      <td><div class="row" style="gap:10px;flex-wrap:nowrap"><div class="avatar">${esc(initials(u.name))}</div><div><b>${esc(u.name)}</b>${u.id === state.user.id ? ' <span class="chip">это вы</span>' : ''}</div></div></td>
      <td>${esc(u.email)}<div class="sub">${esc(u.phone) || ''}</div></td>
      <td class="nowrap">${dt(u.created_at)}</td>
      <td>${u.orders_count}</td>
      <td><select class="status-select" data-role="${u.id}" ${u.id === state.user.id ? 'disabled' : ''}>${Object.entries(state.meta.roles).map(([k, v]) => `<option value="${k}" ${k === u.role ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></td>
      <td>${u.active ? '<span class="badge s-done">Активен</span>' : '<span class="badge s-ordered">Ожидает / заблокирован</span>'}</td>
      <td class="nowrap right">${u.id === state.user.id ? '' : `${u.active ? `<button class="btn sm danger" data-act="${u.id}" data-v="0">Заблокировать</button>` : `<button class="btn sm ok" data-act="${u.id}" data-v="1">✔ Подтвердить</button>`}
        <button class="icon-btn" data-pw="${u.id}" title="Сменить пароль">🔑</button>${u.orders_count ? '' : `<button class="icon-btn" data-del="${u.id}" title="Удалить">🗑</button>`}`}</td>
    </tr>`).join('')}</tbody></table></div>`);
  const patch = async (id, body, msg) => { await api('/api/users/' + id, { method: 'PATCH', body }); toast(msg); pageUsers(); renderNavCount(); };
  $$('[data-role]', m).forEach((s) => s.onchange = handle(() => patch(s.dataset.role, { role: s.value }, 'Роль изменена')));
  $$('[data-act]', m).forEach((b) => b.onclick = handle(() => patch(b.dataset.act, { active: b.dataset.v === '1' }, b.dataset.v === '1' ? 'Доступ подтверждён' : 'Пользователь заблокирован')));
  $$('[data-del]', m).forEach((b) => b.onclick = handle(async () => { if (await confirmBox('Удалить пользователя?')) { await api('/api/users/' + b.dataset.del, { method: 'DELETE' }); toast('Удалён'); pageUsers(); } }));
  $$('[data-pw]', m).forEach((b) => b.onclick = () => modal(`<h2>Новый пароль</h2><form id="f-pw"><div class="field"><label>Пароль (мин. 6 символов)</label><input name="password" type="text" required minlength="6"></div>
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Отмена</button><button class="btn primary">Сохранить</button></div></form>`,
  (mm, close) => { $('#f-pw', mm).onsubmit = handle(async (e) => { e.preventDefault(); await patch(b.dataset.pw, formData(e.target), 'Пароль изменён'); close(); }); }));
  $('#add', m).onclick = () => modal(`<h2>Новый сотрудник</h2><form id="f-u">
    <div class="field"><label>Имя и фамилия</label><input name="name" required minlength="2"></div>
    <div class="field"><label>Email (логин)</label><input name="email" type="email" required></div>
    <div class="field"><label>Телефон</label><input name="phone"></div>
    <div class="field"><label>Роль</label><select name="role">${Object.entries(state.meta.roles).map(([k, v]) => `<option value="${k}" ${k === 'master' ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
    <div class="field"><label>Пароль (мин. 6 символов)</label><input name="password" type="text" required minlength="6"></div>
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Отмена</button><button class="btn primary">Создать</button></div></form>`,
  (mm, close) => { $('#f-u', mm).onsubmit = handle(async (e) => { e.preventDefault(); await api('/api/users', { method: 'POST', body: formData(e.target) }); close(); toast('Сотрудник добавлен'); pageUsers(); }); });
}
function renderNavCount() { /* обновление бейджа в меню */ const a = $('a[href="#/users"]'); if (!a) return; const c = $('.count', a); if (c) c.remove(); if (state.pendingUsers) a.insertAdjacentHTML('beforeend', `<span class="count">${state.pendingUsers}</span>`); }

/* ====================== Профиль ====================== */
async function pageProfile() {
  const u = state.user;
  const m = setMain(`${head('Профиль')}
    <div class="grid g2">
      <div class="card"><h2>Данные</h2><div class="kv"><div>Имя</div><div>${esc(u.name)}</div><div>Email</div><div>${esc(u.email)}</div><div>Телефон</div><div>${esc(u.phone) || '—'}</div><div>Роль</div><div>${esc(state.meta.roles[u.role])}</div><div>С нами с</div><div>${dt(u.created_at)}</div></div></div>
      <div class="card"><h2>Сменить пароль</h2><form id="f-pw">
        <div class="field"><label>Текущий пароль</label><input name="current" type="password" required autocomplete="current-password"></div>
        <div class="field"><label>Новый пароль</label><input name="password" type="password" required minlength="6" autocomplete="new-password"></div>
        <div class="field"><label>Повторите новый пароль</label><input name="password2" type="password" required minlength="6" autocomplete="new-password"></div>
        <button class="btn primary">Сохранить</button></form></div>
    </div>`);
  $('#f-pw', m).onsubmit = handle(async (e) => {
    e.preventDefault(); const d = formData(e.target);
    if (d.password !== d.password2) throw new Error('Пароли не совпадают');
    await api('/api/auth/password', { method: 'POST', body: d }); e.target.reset(); toast('Пароль изменён');
  });
}

/* мобильное меню */
document.addEventListener('click', (e) => { if (e.target.closest('.nav a')) $('#sidebar')?.classList.remove('open'); });
boot();
