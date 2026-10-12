const CACHE_NAME = 'daspe-v1';
const STATIC_ASSETS = ['/', '/assets/css/main.css', '/assets/js/app.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))));
  self.clients.claim();
});

// Push notification handler — works even when browser is closed
self.addEventListener('push', (e) => {
  if (!e.data) return;
  let data = {};
  try { data = e.data.json(); } catch { data = { title: 'Daspe', body: e.data.text() }; }

  const icons = {
    success: '/assets/img/icon-success.png',
    error: '/assets/img/icon-error.png',
    warning: '/assets/img/icon-warning.png',
    info: '/assets/img/icon-info.png',
    admin: '/assets/img/icon-admin.png'
  };

  const options = {
    body: data.body || '',
    icon: '/assets/img/icon-192.png',
    badge: '/assets/img/badge-72.png',
    tag: data.deploymentId || data.type || 'daspe-notif',
    data: { url: data.deploymentId ? `/dashboard/deployment.html?id=${data.deploymentId}` : '/dashboard/', ...data },
    vibrate: [200, 100, 200],
    requireInteraction: data.type === 'error',
    actions: data.deploymentId ? [
      { action: 'view', title: 'View Deployment' },
      { action: 'dismiss', title: 'Dismiss' }
    ] : []
  };

  e.waitUntil(self.registration.showNotification(data.title || 'Daspe', options));
});

// Notification click handler
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.action === 'view' ? e.notification.data.url : (e.notification.data.url || '/dashboard/');
  if (e.action === 'dismiss') return;
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
    for (const client of clientList) {
      if (client.url.includes(self.location.origin) && 'focus' in client) {
        client.navigate(url);
        return client.focus();
      }
    }
    if (clients.openWindow) return clients.openWindow(url);
  }));
});

// Fetch handler (cache-first for static, network-first for API)
self.addEventListener('fetch', (e) => {
  if (e.request.url.includes('/api/') || e.request.url.includes('/auth/')) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).catch(() => cached))
  );
});
