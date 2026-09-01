/* ヘルスきち Service Worker v16
 * 自動更新対応: アプリシェル(index.html / core.js)はネットワーク優先で常に最新を取り、
 * オフライン時のみキャッシュにフォールバックする。それ以外はキャッシュ優先。 */
const CACHE = "hk-v16";
const ASSETS = ["./", "./index.html", "./core.js", "./manifest.webmanifest",
                "./icon-192.png", "./icon-512.png"];
const FRESH = /(\/$|index\.html$|core\.js$|manifest\.webmanifest$)/;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
  ).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // Gemini API等は素通し

  if (e.request.mode === "navigate" || FRESH.test(url.pathname)) {
    // ネットワーク優先(成功したらキャッシュ更新)、失敗時のみキャッシュ
    e.respondWith(
      fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      }).catch(() => caches.match(e.request).then((hit) => hit || caches.match("./index.html")))
    );
  } else {
    e.respondWith(
      caches.match(e.request).then((hit) => hit ||
        fetch(e.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
      )
    );
  }
});
