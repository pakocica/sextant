/* ════════════════════════════════════════════════════════════════════════════
   SEXTANT — SERVICE WORKER  (2026-08-15)
   The offline half of the PWA. Published alongside index.html; registered by the
   engine in CLOUD MODE ONLY (see the registration block in index.html), so local
   development with decks.js present never installs a worker and never serves
   Pavel a stale engine.

   THE ONE RULE THAT MATTERS: the app document is NETWORK-FIRST.
   publish.sh force-pushes a fresh engine and users must get it on the next load —
   a cache-first shell would pin thousands of students to whatever version they
   first installed, and no cache-busting trick reaches a page the SW is serving
   from cache. So: try the network, fall back to the cached copy only when the
   network actually fails. Offline still works; staleness cannot happen online.

   Everything else is split by whether the URL is immutable:
     · versioned third-party code (Firebase SDK 10.12.2, Google font files) —
       cache-first, they never change under a given URL;
     · the Google Fonts CSS — stale-while-revalidate (same URL, rare changes);
     · own static assets (icons, manifest) — stale-while-revalidate;
     · the read-aloud library under /sextant-audio/audio/ — the mp3s AND the per-word
       timing sidecars (.json, same hashed basename) — cache-first, because those
       filenames carry a content hash and a given URL is immutable; the library's root
       manifest.json — network-first (fresh library, cached fallback offline). All of it lives in its OWN cache (AUDIO),
       versioned apart from VERSION: publishing a new engine must not evict a library
       of thousands of files that did not change;
     · the same library on its R2 host (AUDIO_HOSTS, 2026-10-04) — the same two rules into
       the same AUDIO cache, except that an audio file is fetched by the worker itself in
       CORS mode and only a full 200 CORS answer is cached: an <audio> element asks no-cors,
       and OPAQUE answers must never be cached (Chrome charges each ~7 MB of quota — a few
       hundred would push the origin into eviction, IndexedDB content packs included);
     · EVERYTHING ELSE — untouched. Firestore/Auth traffic must never be
       intercepted: it is long-lived, streaming and auth-scoped, it has its own
       offline layer, and a SW sitting in the middle of it breaks sign-in in ways
       that are very hard to debug. Non-GET is likewise passed straight through.

   Content and progress are NOT cached here — course packs live in IndexedDB
   (eote_packs) and progress in localStorage, both managed by the engine.
   ════════════════════════════════════════════════════════════════════════════ */
const VERSION   = "v1";
const SHELL     = "sextant-shell-" + VERSION;   /* the app document + own assets */
const VENDOR    = "sextant-vendor-" + VERSION;  /* fonts + Firebase SDK          */
const AUDIO     = "sextant-audio-v3";           /* pre-generated card mp3s + manifest —
                                                   own version: engine publishes must not evict it.
   v2 (2026-10-09): 1,384 clips (ep1, ubmicro1, ubintroecon) were re-rendered under the SAME names
   (tts_gen §2m speech fixes), so a device's cache-first copy would keep the old reading for ever. The
   new name makes activate (below) delete every device's v1 copy; clips come back one at a time as they
   are played or warmed — the same on-demand fetches as a fresh device, never a bulk download.
   v3 (2026-10-10): again — 864 public clips re-rendered under their names (18 for the Micro I math
   rules, 846 for the money / range / time rules, audio.md §2n): activate deletes every device's v2.
   index.html's AP_CACHE names this cache, and the page's private partitions (privaudio-*, never
   this worker's: activate leaves them alone) carry the same generation, so the one bump covers both.
   A re-render under the same names must bump this again (docs/context/audio.md). */
const KEEP      = [SHELL, VENDOR, AUDIO];

/* Same-origin things worth having before the first offline launch. Kept tiny and
   fault-tolerant: one 404 must not fail the whole install. */
const PRECACHE = ["./", "./manifest.json", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];

/* Immutable, cache-first hosts */
const VENDOR_HOSTS = ["fonts.gstatic.com", "www.gstatic.com"];
/* The read-aloud library's R2 host (the sextant-audio Worker; index.html AUDIO_BASES[0]) */
const AUDIO_HOSTS  = ["sextant-audio.pakoinf.workers.dev"];
/* Same URL, contents can change → revalidate in the background */
const SWR_HOSTS    = ["fonts.googleapis.com"];

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await Promise.all(PRECACHE.map(u => c.add(u).catch(() => {}))); /* best effort */
    self.skipWaiting();
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.startsWith("sextant-") && !KEEP.includes(n)).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

/* let the page trigger an immediate update (used by the "reload for the new version" path) */
self.addEventListener("message", e => { if (e.data === "skipWaiting") self.skipWaiting(); });

async function networkFirst(req, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) cache.put(fallbackUrl || req, fresh.clone());
    return fresh;
  } catch (err) {
    const hit = await cache.match(fallbackUrl || req, { ignoreSearch: !!fallbackUrl });
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const fresh = await fetch(req);
  if (fresh && (fresh.ok || fresh.type === "opaque")) cache.put(req, fresh.clone());
  return fresh;
}

/* cross-origin audio: never store an opaque answer. On a miss the worker asks for the file
   itself — CORS, no credentials, no Range — so the cache gets the whole 200 body, which then
   answers the media element's Range probes too (a CORS response may answer a no-cors request).
   If that CORS fetch fails, the original request goes through untouched and nothing is cached.
   cache:"no-cache" — the R2 Worker sends audio as `immutable` for a year, so the browser's HTTP cache
   would hand a miss here the OLD bytes of a file re-rendered under its name; no-cache revalidates
   instead (If-None-Match: a 304 when the file is unchanged, the new file when it is not). */
async function audioFirst(req) {
  const cache = await caches.open(AUDIO);
  const href = req.url;
  const hit = await cache.match(href, { ignoreVary: true });
  if (hit) return hit;
  let fresh;
  try { fresh = await fetch(href, { mode: "cors", credentials: "omit", cache: "no-cache" }); }
  catch (err) { return fetch(req); }
  if (fresh && fresh.status === 200 && fresh.type === "cors") cache.put(href, fresh.clone());
  return fresh;
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const net = fetch(req).then(r => {
    if (r && (r.ok || r.type === "opaque")) cache.put(req, r.clone());
    return r;
  }).catch(() => null);
  return hit || (await net) || Response.error();
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;                       /* writes always go to the network */
  const url = new URL(req.url);

  /* the app document — network-first so a published engine update always wins.
     `mode: "navigate"` covers link opens, installs and reloads; the ?k= / ?c= query
     is stripped for the cache key (ignoreSearch) so every share link falls back to
     the same cached shell. */
  if (req.mode === "navigate") {
    e.respondWith(networkFirst(req, SHELL, "./"));
    return;
  }

  if (url.origin === self.location.origin) {
    /* the read-aloud library, all of it into AUDIO. The root manifest changes whenever a
       card does, so revalidate — and it goes FIRST so no later rule (the generic .json one
       below included) can shadow it. Everything under /audio/ — the mp3s and the per-word
       timing sidecars beside them — carries a content hash in its name and is therefore
       immutable, so cache-first. */
    /* NETWORK-first (2026-08-28): SWR handed the page a manifest one audio-push old, so a
       fresh library's segments fell back to the device voice until the NEXT full load. The
       mp3s are hash-named and immutable — only this index needs to be current. */
    if (url.pathname === "/sextant-audio/manifest.json")  { e.respondWith(networkFirst(req, AUDIO)); return; }
    if (/^\/sextant-audio\/audio\/.+\.(mp3|json)$/i.test(url.pathname)) { e.respondWith(cacheFirst(req, AUDIO)); return; }
    /* own assets: icons, manifest — fresh-ish but instant */
    if (/\.(png|svg|json|webmanifest)$/i.test(url.pathname)) e.respondWith(staleWhileRevalidate(req, SHELL));
    return;                                               /* anything else: straight to the network */
  }

  /* the library on R2: index network-first, hashed files audioFirst (above), both into AUDIO;
     anything else on that host (robots.txt, a stray path) goes straight to the network */
  if (AUDIO_HOSTS.includes(url.hostname)) {
    if (url.pathname === "/manifest.json")              { e.respondWith(networkFirst(req, AUDIO)); return; }
    if (/^\/audio\/.+\.(mp3|json)$/i.test(url.pathname)) { e.respondWith(audioFirst(req)); return; }
    return;
  }

  if (VENDOR_HOSTS.includes(url.hostname)) { e.respondWith(cacheFirst(req, VENDOR)); return; }
  if (SWR_HOSTS.includes(url.hostname))    { e.respondWith(staleWhileRevalidate(req, VENDOR)); return; }

  /* Firestore, Identity Toolkit, everything else — never intercepted */
});
