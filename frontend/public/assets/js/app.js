// DASPE APP CORE

const api = {
  async req(method, path, body) {
    const opts = { method, credentials: 'include', headers: {} };
    if (body && !(body instanceof FormData)) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    } else if (body instanceof FormData) {
      opts.body = body;
    }
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  },
  get: p => api.req('GET', p),
  post: (p, b) => api.req('POST', p, b),
  put: (p, b) => api.req('PUT', p, b),
  patch: (p, b) => api.req('PATCH', p, b),
  del: p => api.req('DELETE', p),
};

const toast = {
  _root: null,
  _get() { if (!this._root) { this._root = document.createElement('div'); this._root.id = 'toast-root'; document.body.appendChild(this._root); } return this._root; },
  show(msg, type = 'info', ms = 4000) {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    this._get().appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(110%)'; el.style.transition = '.25s'; setTimeout(() => el.remove(), 280); }, ms);
  },
  success: m => toast.show(m, 'success'),
  error: m => toast.show(m, 'error'),
  info: m => toast.show(m, 'info'),
  warning: m => toast.show(m, 'warning'),
};

const modal = {
  open: id => document.getElementById(id)?.classList.add('open'),
  close: id => document.getElementById(id)?.classList.remove('open'),
  closeAll: () => document.querySelectorAll('.overlay').forEach(o => o.classList.remove('open')),
};
document.addEventListener('click', e => { if (e.target.classList.contains('overlay')) modal.closeAll(); });

function confirm(title, msg, okText = 'Confirm', danger = true) {
  return new Promise(resolve => {
    const d = document.createElement('div');
    d.className = 'overlay open';
    d.innerHTML = `<div class="modal" style="max-width:380px"><div class="modal-hd"><span class="modal-title">${title}</span></div><p style="color:var(--white-4);font-size:.88rem;margin-bottom:4px">${msg}</p><div class="modal-ft"><button class="btn btn-ghost btn-sm" id="_cNo">Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'} btn-sm" id="_cYes">${okText}</button></div></div>`;
    document.body.appendChild(d);
    d.querySelector('#_cNo').onclick = () => { d.remove(); resolve(false); };
    d.querySelector('#_cYes').onclick = () => { d.remove(); resolve(true); };
    d.addEventListener('click', e => { if (e.target === d) { d.remove(); resolve(false); } });
  });
}

const fmt = {
  mb: v => v >= 1024 ? `${(v/1024).toFixed(1)} GB` : `${Math.round(v)} MB`,
  ago: d => { const s = (Date.now() - new Date(d)) / 1000; if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s/60)}m ago`; if (s < 86400) return `${Math.floor(s/3600)}h ago`; return `${Math.floor(s/86400)}d ago`; },
  date: d => new Date(d).toLocaleDateString('en-US', {month:'short',day:'numeric',year:'numeric'}),
  badge: s => `<span class="badge badge-${s}"><span class="live-dot"></span>${s}</span>`,
  runtime: r => { const m = {node:'Node.js',python:'Python',go:'Go',php:'PHP',ruby:'Ruby',bun:'Bun',deno:'Deno',java:'Java',rust:'Rust',static:'Static',custom:'Docker'}; return m[r] || r; },
};

function resBar(used, total, label) {
  const pct = total > 0 ? Math.min(100, used / total * 100) : 0;
  const cls = pct > 90 ? 'danger' : pct > 70 ? 'warn' : 'ok';
  return `<div class="res-bar-wrap"><div class="res-bar-label"><span>${label}</span><span>${fmt.mb(used)} / ${fmt.mb(total)}</span></div><div class="res-bar"><div class="res-bar-fill res-fill-${cls}" style="width:${pct}%"></div></div></div>`;
}

async function checkAuth(redirect = '/') {
  try { return await api.get('/auth/me'); }
  catch { window.location.href = redirect; return null; }
}

async function updateNotifBadge() {
  try {
    const d = await api.get('/api/user/notifications/unread-count');
    document.querySelectorAll('.notif-dot').forEach(el => {
      el.textContent = d.count;
      el.classList.toggle('show', d.count > 0);
    });
    const nb = document.getElementById('sideNotifBadge');
    if (nb) { nb.textContent = d.count; nb.style.display = d.count > 0 ? 'block' : 'none'; }
  } catch {}
}

function initSidebar(activeId) {
  const btn = document.getElementById('mobileMenuBtn');
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  if (btn) btn.onclick = () => { sidebar.classList.toggle('open'); };
  if (overlay) overlay.onclick = () => sidebar.classList.remove('open');
  if (activeId) {
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    const el = document.getElementById(activeId);
    if (el) el.classList.add('active');
  }
}

async function logout() {
  await api.post('/auth/logout');
  window.location.href = '/';
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
