/* =====================================================================
   QLog Pro Ultimate - Offline-first Service Worker
   ---------------------------------------------------------------------
   - Precaches the complete application (shell, libs, face models, fonts,
     icons) so the installed desktop PWA runs with NO internet at all.
   - Cache-first for app resources, network-first for navigations with an
     index.html app-shell fallback.
   - Never touches localStorage: user data (people, logs, books,
     borrowLogs, reservations, auditLogs, config, sessions) survives every
     service-worker update.
   ===================================================================== */

const CACHE_NAME = "qlogpro-offline-v18-live-registry-inline-edit";

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./central-client.js",
  "./manifest.json",
  "./install-gate.js",
  "./fonts/Inter-400-latin-ext.woff2",
  "./fonts/Inter-400-latin.woff2",
  "./fonts/Inter-500-latin-ext.woff2",
  "./fonts/Inter-500-latin.woff2",
  "./fonts/Inter-600-latin-ext.woff2",
  "./fonts/Inter-600-latin.woff2",
  "./fonts/Inter-700-latin-ext.woff2",
  "./fonts/Inter-700-latin.woff2",
  "./fonts/Inter-800-latin-ext.woff2",
  "./fonts/Inter-800-latin.woff2",
  "./fonts/JetBrainsMono-500-latin-ext.woff2",
  "./fonts/JetBrainsMono-500-latin.woff2",
  "./fonts/JetBrainsMono-600-latin-ext.woff2",
  "./fonts/JetBrainsMono-600-latin.woff2",
  "./fonts/fonts.css",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./libs/face-api.min.js",
  "./libs/html2pdf.bundle.min.js",
  "./libs/jsQR.js",
  "./libs/qrcode.min.js",
  "./libs/xlsx.full.min.js",
  "./libs/onnx/ort.wasm.min.js",
  "./libs/onnx/ort-wasm-simd-threaded.mjs",
  "./libs/onnx/ort-wasm-simd-threaded.wasm",
  "./libs/ppocr/ppocr.js",
  "./models/ppocr/det.onnx",
  "./models/ppocr/rec.onnx",
  "./models/ppocr/en_dict.json",
  "./models/age_gender_model-weights_manifest.json",
  "./models/age_gender_model.bin",
  "./models/face_expression_model-weights_manifest.json",
  "./models/face_expression_model.bin",
  "./models/face_landmark_68_model-weights_manifest.json",
  "./models/face_landmark_68_model.bin",
  "./models/face_landmark_68_tiny_model-weights_manifest.json",
  "./models/face_landmark_68_tiny_model.bin",
  "./models/face_recognition_model-weights_manifest.json",
  "./models/face_recognition_model.bin",
  "./models/ssd_mobilenetv1_model-weights_manifest.json",
  "./models/ssd_mobilenetv1_model.bin",
  "./models/tiny_face_detector_model-weights_manifest.json",
  "./models/tiny_face_detector_model.bin",
];

/* ---------- Install: precache everything, individually so one failure
     cannot abort the whole install ---------- */
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const results = await Promise.allSettled(
        PRECACHE_URLS.map(async (url) => {
          const request = new Request(url, { cache: "reload" });
          const response = await fetch(request);
          if (!response || !response.ok) throw new Error("HTTP " + (response && response.status) + " for " + url);
          await cache.put(url, response.clone());
          return url;
        })
      );
      const failed = results
        .map((r, i) => (r.status === "rejected" ? PRECACHE_URLS[i] : null))
        .filter(Boolean);
      if (failed.length) console.warn("[QLog SW] Some resources failed to precache:", failed);
      else console.log("[QLog SW] Precached", PRECACHE_URLS.length, "resources.");
      await self.skipWaiting();
    })()
  );
});

/* ---------- Activate: drop old caches only (localStorage untouched) ---------- */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_NAME && k.startsWith("qlogpro")).map((k) => caches.delete(k))
      );
      if (self.registration.navigationPreload) {
        try { await self.registration.navigationPreload.enable(); } catch (e) {}
      }
      await self.clients.claim();
      console.log("[QLog SW] Active:", CACHE_NAME);
    })()
  );
});

/* ---------- Fetch ---------- */
const OFFLINE_SHELL = "./index.html";

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Never intercept cross-origin requests; the central API lives on qlog-api.mdmsportal.uk.
  // Network requests to the central API must stay live and must not be cached.
  if (url.origin !== self.location.origin) return;
  if (url.hostname === "qlog-api.mdmsportal.uk") return;

  // Navigations: network-first (fresh deploys), always fall back to the cached shell.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const preload = await event.preloadResponse;
          if (preload) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(OFFLINE_SHELL, preload.clone());
            return preload;
          }
          const fresh = await fetch(request);
          if (fresh && fresh.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(OFFLINE_SHELL, fresh.clone());
          }
          return fresh;
        } catch (e) {
          const cache = await caches.open(CACHE_NAME);
          return (
            (await cache.match(OFFLINE_SHELL)) ||
            (await cache.match("./")) ||
            new Response(
              "<h1>QLog Pro</h1><p>The application shell is not cached yet. Connect once while online to complete installation.</p>",
              { headers: { "Content-Type": "text/html" } }
            )
          );
        }
      })()
    );
    return;
  }

  // App resources: cache-first, then network, then a safe offline response.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;
      try {
        const fresh = await fetch(request);
        if (fresh && fresh.ok && fresh.type === "basic") cache.put(request, fresh.clone());
        return fresh;
      } catch (e) {
        // Offline and not cached: fail softly so one request can never blank the app.
        if (request.destination === "document") {
          const shell = await cache.match(OFFLINE_SHELL);
          if (shell) return shell;
        }
        return new Response("", { status: 504, statusText: "Offline - resource not cached" });
      }
    })()
  );
});

/* ---------- Messages: allow the page to trigger an immediate update ---------- */
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});
