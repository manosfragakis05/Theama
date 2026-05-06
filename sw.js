const CACHE_NAME = 'torbox-theater-v11';
const ASSETS = [
    './',
    './index.html',
    './style.css',
    
    // Core App Logic
    './script.js',
    './api.js',
    './player.js',
    './parseMedia.js',
    
    // External Libraries (Downloaded locally)
    './artplayer.js',
    './ptt.js',
    
    // MKV Engine (Exact spelling retained!)
    './engine/mkv_lib.js',
    './engine/streaming-engine.js', 
    './engine/streaming_engine.wasm'
];

// Install: Cache the UI Shell and force update
self.addEventListener('install', (event) => {
    self.skipWaiting(); 
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
});

// Activate: Delete any old versions of the cache
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('Deleting old cache:', cacheName);
                        return caches.delete(cacheName); 
                    }
                })
            );
        })
    );
    self.clients.claim(); 
});

// THE SINGLE MASTER FETCH LISTENER
self.addEventListener('fetch', (event) => {
    
    // 0. VIP LANE: Ignore POST/PUT requests (Caches crash if they try to read these)
    if (event.request.method !== 'GET') {
        return; 
    }

    // 1. VIP LANE: Ignore local device files (blobs) completely
    if (event.request.url.startsWith('blob:')) {
        return; 
    }

    // 2. VIP LANE: Ignore Video Chunking (Range requests)
    if (event.request.headers.has('range')) {
        return;
    }

    // 3. Ignore external APIs (like TorBox/TMDB)
    if (!event.request.url.startsWith(self.location.origin)) {
        return;
    }

    // 4. Standard Cache WITH Offline Crash Protection
    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            // If it's in the cache, serve it. If not, try the network.
            return cachedResponse || fetch(event.request).catch(() => {
                // If the network fails (because we are offline), safely catch the error
                // instead of crashing the Service Worker.
                console.warn("Offline: Could not fetch", event.request.url);
                return new Response("Offline", { status: 503, statusText: "Service Unavailable" });
            });
        })
    );
});