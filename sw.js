/* Service Worker: アプリ本体を全キャッシュし、オフラインでも起動可能にする */
"use strict";

const CACHE = "netdiag-v6";
const ASSETS = [
  "./",
  "index.html",
  "probe-engine.js",
  "road-view.js",
  "log-store.js",
  "manifest.json",
  "icon-180.png",
  "icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // プローブ（外部宛て）はキャッシュせず素通し。計測結果を汚染しない
  if (url.origin !== location.origin) return;
  // アプリ本体はキャッシュ優先 → オフラインでも起動できる
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true })
      .then((hit) => hit || fetch(e.request))
  );
});
