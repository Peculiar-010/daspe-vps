// DASPE APP CORE — Fixed

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
  init() {
    if (!document.getElementById('toast-root')) {
      const el = document.createElement('div');
      el.id = 'toast-root';
      el.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:6px';
      document.body.appendChild(el);
    }
  },
  show(msg, type, ms) {
    this.init();
    ms = ms || 4000;
    type = type || 'info';
    const el = document.createElement('div');
    el.style.cssText = `padding:12px 18px;border-radius:8px;font-size:.85rem;font-weight:500;max-width:340px;border-left:3px solid;background:#141414;font-family:'Inter',sans-serif;animation:toastIn .25s ease`;
    const colors = { success: '#4ade80', error: '#f87171', info: '#60a5fa', warning: '#fbbf24' };
    el.style.borderColor = colors[type] || colors.info;
    el.style.color = colors[type] || colors.info;
    el.textContent = msg;
    document.getElementById('toast-root').appendChild(el);
    setTimeout(function() {
      el.style.opacity = '0';
      el.style.transition = '.25s';
      setTimeout(function() { el.remove(); }, 280);
    }, ms);
  },
  success: function(m) { toast.show(m, 'success'); },
  error: function(m) { toast.show(m, 'error'); },
  info: function(m) { toast.show(m, 'info'); },
  warning: function(m) { toast.show(m, 'warning'); },
};

// Add toast animation
(function() {
  const style = document.createElement('style');
  style.textContent = '@keyframes toastIn{from{transform:translateX(100%);opacity:0}to{transform:translateX(0);opacity:1}}';
  document.head.appendChild(style);
})();

const modal = {
  open: function(id) { const el = document.getElementById(id); if (el) el.classList.add('open'); },
  close: function(id) { const el = document.getElementById(id); if (el) el.classList.remove('open'); },
  closeAll: function() { document.querySelectorAll('.overlay').forEach(function(o) { o.classList.remove('open'); }); }
};

document.addEventListener('click', function(e) {
  if (e.target.classList.contains('overlay')) modal.closeAll();
});

function confirm(title, msg, okText, danger) {
  okText = okText || 'Confirm';
  danger = danger !== false;
  return new Promise(function(resolve) {
    const d = document.createElement('div');
    d.className = 'overlay open';
    d.style.cssText = 'position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.75);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:16px';
    d.innerHTML = '<div style="background:#0e0e0e;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:24px;width:100%;max-width:360px;box-shadow:0 24px 64px rgba(0,0,0,.6)"><div style="font-size:1rem;font-weight:700;margin-bottom:10px">'+title+'</div><p style="color:rgba(255,255,255,.4);font-size:.88rem;margin-bottom:20px">'+msg+'</p><div style="display:flex;gap:8px;justify-content:flex-end"><button id="_cNo" style="padding:8px 16px;border-radius:8px;border:1px solid rgba(255,255,255,.08);background:transparent;color:rgba(255,255,255,.5);cursor:pointer;font-family:inherit;font-size:.85rem">Cancel</button><button id="_cYes" style="padding:8px 16px;border-radius:8px;border:none;background:'+(danger?'rgba(248,113,113,.15)':'#fff')+';color:'+(danger?'#f87171':'#000')+';cursor:pointer;font-family:inherit;font-size:.85rem;font-weight:600">'+okText+'</button></div></div>';
    document.body.appendChild(d);
    d.querySelector('#_cNo').onclick = function() { d.remove(); resolve(false); };
    d.querySelector('#_cYes').onclick = function() { d.remove(); resolve(true); };
    d.addEventListener('click', function(e) { if (e.target === d) { d.remove(); resolve(false); } });
  });
}

const fmt = {
  mb: function(v) { return v >= 1024 ? (v/1024).toFixed(1)+' GB' : Math.round(v)+' MB'; },
  ago: function(d) {
    const s = (Date.now() - new Date(d)) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s/60)+'m ago';
    if (s < 86400) return Math.floor(s/3600)+'h ago';
    return Math.floor(s/86400)+'d ago';
  },
  date: function(d) { return new Date(d).toLocaleDateString('en-US', {month:'short',day:'numeric',year:'numeric'}); },
  badge: function(s) {
    const colors = {
      running: 'background:rgba(74,222,128,.1);color:#4ade80;border:1px solid rgba(74,222,128,.15)',
      stopped: 'background:rgba(255,255,255,.05);color:rgba(255,255,255,.4);border:1px solid rgba(255,255,255,.08)',
      building: 'background:rgba(96,165,250,.1);color:#60a5fa;border:1px solid rgba(96,165,250,.15)',
      failed: 'background:rgba(248,113,113,.1);color:#f87171;border:1px solid rgba(248,113,113,.15)',
      sleeping: 'background:rgba(251,191,36,.1);color:#fbbf24;border:1px solid rgba(251,191,36,.15)',
      pending: 'background:rgba(251,191,36,.1);color:#fbbf24;border:1px solid rgba(251,191,36,.15)',
      active: 'background:rgba(74,222,128,.1);color:#4ade80;border:1px solid rgba(74,222,128,.15)',
      suspended: 'background:rgba(248,113,113,.1);color:#f87171;border:1px solid rgba(248,113,113,.15)',
      rejected: 'background:rgba(255,255,255,.05);color:rgba(255,255,255,.4);border:1px solid rgba(255,255,255,.08)',
    };
    const c = colors[s] || colors.stopped;
    return '<span style="display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:50px;font-size:.72rem;font-weight:700;'+c+'"><span style="width:5px;height:5px;border-radius:50%;background:currentColor;display:inline-block"></span>'+s+'</span>';
  },
  runtime: function(r) {
    const m = {node:'Node.js',python:'Python',go:'Go',php:'PHP',ruby:'Ruby',bun:'Bun',deno:'Deno',java:'Java',rust:'Rust',static:'Static',custom:'Docker'};
    return m[r] || r;
  }
};

function resBar(used, total, label) {
  const pct = total > 0 ? Math.min(100, used / total * 100) : 0;
  const color = pct > 90 ? '#f87171' : pct > 70 ? '#fbbf24' : '#4ade80';
  return '<div style="display:flex;flex-direction:column;gap:5px"><div style="display:flex;justify-content:space-between;font-size:.78rem"><span style="color:rgba(255,255,255,.5)">'+label+'</span><span style="color:rgba(255,255,255,.25)">'+fmt.mb(used)+' / '+fmt.mb(total)+'</span></div><div style="height:5px;background:#222;border-radius:99px;overflow:hidden"><div style="height:100%;border-radius:99px;background:'+color+';width:'+pct+'%"></div></div></div>';
}

async function checkAuth(redirect) {
  redirect = redirect || '/';
  try { return await api.get('/auth/me'); }
  catch(e) { window.location.href = redirect; return null; }
}

async function updateNotifBadge() {
  try {
    const d = await api.get('/api/user/notifications/unread-count');
    document.querySelectorAll('.notif-dot').forEach(function(el) {
      el.textContent = d.count;
      el.className = 'notif-dot' + (d.count > 0 ? ' show' : '');
    });
    const nb = document.getElementById('sideNotifBadge');
    if (nb) { nb.textContent = d.count; nb.style.display = d.count > 0 ? 'block' : 'none'; }
  } catch(e) {}
}

function initSidebar() {
  const btn = document.getElementById('mobileMenuBtn');
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  if (btn && sidebar) {
    btn.addEventListener('click', function() { sidebar.classList.toggle('open'); });
  }
  if (overlay && sidebar) {
    overlay.addEventListener('click', function() { sidebar.classList.remove('open'); });
  }
}

async function logout() {
  try { await api.post('/auth/logout'); } catch(e) {}
  window.location.href = '/';
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(function() {});
}
