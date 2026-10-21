/* Breed Manager service worker: keeps the app usable offline, picks up new versions on the next open,
   and serves photos stored in IndexedDB at "_blob/<id>". Bump VERSION on every release. */
const VERSION = "2026-10-22-2";
const SHELL = `bm-shell-${VERSION}`, LIBS = "bm-libs-v1";
const SHELL_FILES = ["./", "./index.html", "./runtime.js", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png"];

self.addEventListener("install", e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES))); });
self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("bm-shell-") && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener("message", e => { if (e.data === "skipWaiting") self.skipWaiting(); });

const blobFromIdb = id => new Promise(res => {
  const r = indexedDB.open("breed-manager", 1);
  r.onupgradeneeded = () => { r.transaction.abort(); res(null); };
  r.onerror = () => res(null);
  r.onsuccess = () => { try { const g = r.result.transaction("blobs", "readonly").objectStore("blobs").get(id); g.onsuccess = () => res(g.result || null); g.onerror = () => res(null); } catch { res(null); } };
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  const blobMatch = url.origin === location.origin && url.pathname.match(/\/_blob\/([0-9a-f]{32})$/);
  if (blobMatch) {
    e.respondWith(blobFromIdb(blobMatch[1]).then(b => b ? new Response(b, { headers: { "Content-Type": b.type || "image/jpeg", "Cache-Control": "no-store" } }) : new Response("", { status: 404 })));
    return;
  }
  if (url.origin === location.origin) {
    // app files: network first so a new release shows up on the next open, cache when offline
    e.respondWith(fetch(e.request).then(r => { if (r.ok) { const c = r.clone(); caches.open(SHELL).then(s => s.put(e.request, c)); } return r; }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match("./index.html"))));
    return;
  }
  if (/^(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)$/.test(url.hostname)) {
    // pinned libraries and fonts: cache first
    e.respondWith(caches.open(LIBS).then(async c => { const hit = await c.match(e.request); if (hit) return hit; const r = await fetch(e.request); if (r.ok || r.type === "opaque") c.put(e.request, r.clone()); return r; }));
  }
});
