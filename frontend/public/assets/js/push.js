async function registerPush() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return false;
    const r = await api.get('/auth/push-key');
    if (!r.publicKey) return false;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(r.publicKey) });
    const res = await api.post('/auth/push-subscribe', { subscription: sub });
    return res.success;
  } catch (e) { console.error(e); return false; }
}
function b64(s) {
  const p = '='.repeat((4 - s.length % 4) % 4);
  const b = (s + p).replace(/-/g,'+').replace(/_/g,'/');
  return Uint8Array.from([...atob(b)].map(c => c.charCodeAt(0)));
}
