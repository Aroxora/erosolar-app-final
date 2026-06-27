// Erosolar service worker — app-shell cache for offline + resilient loads.
//
// Strategy (chosen so a deploy can NEVER pair a fresh index.html with stale logic,
// and a bad response can never poison the shell):
//   • Navigations (HTML): network-first; cache only a GOOD root document; offline →
//     cached shell.
//   • Executable shell (app.js / styles.css / firebase-config.js): network-first too,
//     so HTML and logic always come from the SAME deploy (no version skew). Online
//     this is still fast (served from the browser HTTP cache); offline → cache.
//   • Other static (icons / manifest): cache-first + background refresh (stable, no skew).
//   • The Cloud Run API, Firebase auth/firestore, fonts, CDNs, the /api rewrite, and
//     any non-GET: passthrough. Auth'd/dynamic responses are NEVER cached.
//
// Bump VERSION to force a clean re-precache. skipWaiting + clients.claim make a new
// worker take over promptly so a fix ships on the next load.
const VERSION = "erosolar-shell-v1";
const CORE = new Set(["/", "/index.html", "/app.js", "/styles.css", "/firebase-config.js"]);
const SHELL = [
  "/",
  "/index.html",
  "/app.js",
  "/styles.css",
  "/firebase-config.js",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/favicon-32.png",
  "/favicon-16.png",
  "/apple-touch-icon.png",
];

const cacheable = (res) => res && res.ok && res.type === "basic";
const putInCache = (key, res) =>
  caches.open(VERSION).then((c) => c.put(key, res)).catch(() => {});

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      // allSettled: one 404 must not fail the whole install.
      .then((cache) => Promise.allSettled(SHELL.map((u) => cache.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never touch POST (chat / ingest / action)
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return; // API(Cloud Run)/Firebase/fonts/CDN → network
  if (url.pathname.startsWith("/api/")) return; // never cache the hosting /api rewrite

  // Navigations → network-first; cache ONLY a good ROOT document; offline → shell.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (cacheable(res) && (url.pathname === "/" || url.pathname === "/index.html")) {
            putInCache("/index.html", res.clone());
          }
          return res;
        })
        .catch(() => caches.match("/index.html").then((m) => m || caches.match("/")))
    );
    return;
  }

  // Executable shell → network-first (HTML + logic always from one deploy); offline → cache.
  if (CORE.has(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (cacheable(res)) putInCache(req, res.clone());
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Other static (icons / manifest) → cache-first + background refresh.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (cacheable(res)) putInCache(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
