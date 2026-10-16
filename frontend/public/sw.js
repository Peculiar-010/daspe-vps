const CACHE_NAME = 'daspe-v2';
const STATIC_ASSETS = [
  '/assets/css/main.css',
  '/assets/js/app.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .catch(() => {})
  );

  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    )
  );

  self.clients.claim();
});

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data = {};

  try {
    data = event.data.json();
  } catch {
    data = {
      title: 'Daspe',
      body: event.data.text()
    };
  }

  const options = {
    body: data.body || '',
    icon: '/assets/img/icon-192.png',
    badge: '/assets/img/badge-72.png',
    tag: data.deploymentId || data.type || 'daspe-notif',
    data: {
      url: data.deploymentId
        ? `/dashboard/deployment.html?id=${data.deploymentId}`
        : '/dashboard/',
      ...data
    },
    vibrate: [200, 100, 200],
    requireInteraction: data.type === 'error',
    actions: data.deploymentId
      ? [
          { action: 'view', title: 'View Deployment' },
          { action: 'dismiss', title: 'Dismiss' }
        ]
      : []
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'Daspe', options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const url = event.notification.data.url || '/dashboard/';

  event.waitUntil(
    clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    }).then(clientList => {
      for (const client of clientList) {
        if (
          client.url.startsWith(self.location.origin) &&
          'focus' in client
        ) {
          client.navigate(url);
          return client.focus();
        }
      }

      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;

  // Never cache authentication, API, or admin requests.
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/auth/') ||
    url.pathname === '/admin' ||
    url.pathname.startsWith('/admin/')
  ) {
    event.respondWith(fetch(request));
    return;
  }

  // Use the network for HTML so deployed pages don't remain stale.
  if (
    request.mode === 'navigate' ||
    request.destination === 'document' ||
    url.pathname.endsWith('.html')
  ) {
    event.respondWith(
      fetch(request).catch(() => caches.match(request))
    );
    return;
  }

  // Cache-first for other static assets.
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;

      return fetch(request).then(response => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();

          caches.open(CACHE_NAME).then(cache => {
            cache.put(request, copy);
          });
        }

        return response;
      });
    })
  );
});
