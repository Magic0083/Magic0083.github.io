const CACHE_NAME = "my-website-cache";

const OFFLINE_FILES = [
  "./",
  "./index.html",
  "./manifest.json"
];

// Install the service worker
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(OFFLINE_FILES);
    })
  );

  // Activate the new service worker immediately
  self.skipWaiting();
});

// Remove old caches and take control immediately
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      );
    }).then(() => {
      return self.clients.claim();
    })
  );
});

// Handle requests
self.addEventListener("fetch", event => {
  const request = event.request;

  // For page navigations, ALWAYS try the network first.
  // If offline, use the cached index.html.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(response => {
          // Save the newest index.html for offline use
          const responseClone = response.clone();

          caches.open(CACHE_NAME).then(cache => {
            cache.put(request, responseClone);
          });

          return response;
        })
        .catch(() => {
          return caches.match("./index.html");
        })
    );

    return;
  }

  // For everything else:
  // Try the network first, then fall back to cache.
  event.respondWith(
    fetch(request)
      .then(response => {
        // Only cache successful GET requests
        if (request.method === "GET" && response.ok) {
          const responseClone = response.clone();

          caches.open(CACHE_NAME).then(cache => {
            cache.put(request, responseClone);
          });
        }

        return response;
      })
      .catch(() => {
        return caches.match(request);
      })
  );
});
