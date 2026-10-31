export default {
  async fetch(request, env, ctx) {

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type, Range, If-Range",
          "Access-Control-Max-Age": "86400",
        }
      });
    }

    const url = new URL(request.url);

    if (url.pathname === '/sw.js') {
      const assetRequest = new Request(request);
      assetRequest.headers.delete('If-None-Match');
      assetRequest.headers.delete('If-Modified-Since');

      const response = await env.ASSETS.fetch(assetRequest);

      // 2. Safely handle the body. If it's a 204 or 304, pass null to prevent runtime crashes
      const cleanBody = [204, 304].includes(response.status) ? null : response.body;
      const modifiedResponse = new Response(cleanBody, response);

      // 3. Apply the absolute no-cache headers
      modifiedResponse.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      modifiedResponse.headers.set('Pragma', 'no-cache');
      modifiedResponse.headers.set('Expires', '0');

      return modifiedResponse;
    }

    if (url.pathname === '/map') {
      const tmdbIdParam = url.searchParams.get("tmdb_id");

      if (!tmdbIdParam) {
        return new Response(JSON.stringify({ error: "Missing tmdb_id query parameter." }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      const fribbUrl = "https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json";
      const cache = caches.default;
      const cacheKey = new Request(fribbUrl);

      try {
        let mappingRes = await cache.match(cacheKey);

        if (!mappingRes) {
          mappingRes = await fetch(fribbUrl);
          if (!mappingRes.ok) throw new Error("Failed to fetch from Fribb");

          const responseToCache = new Response(mappingRes.clone().body, mappingRes);
          responseToCache.headers.set("Cache-Control", "s-maxage=43200"); // 12 hour cache
          ctx.waitUntil(cache.put(cacheKey, responseToCache));
        }

        const mappings = await mappingRes.json();

        // 1. Filter to grab all seasons/parts (Raw Fribb Objects)
        const matches = mappings.filter(item => {
          const tmdb = item.themoviedb_id;
          if (!tmdb) return false;
          const movieIds = [].concat(tmdb.movie ?? []).map(String);
          return String(tmdb.tv) === tmdbIdParam || movieIds.includes(tmdbIdParam);
        });

        // 2. Return the raw array directly
        if (matches.length > 0) {
          return new Response(JSON.stringify({
            tmdb_id: parseInt(tmdbIdParam, 10),
            total_matches: matches.length,
            matches: matches
          }), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "public, max-age=86400"
            }
          });
        } else {
          return new Response(JSON.stringify({ error: `TMDB ID ${tmdbIdParam} not found in the mapping.` }), {
            status: 404,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
          });
        }
      } catch (error) {
        return new Response(JSON.stringify({ error: "Server error", details: error.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }
    }

    let targetUrl = url.searchParams.get("url");

    if (!targetUrl && url.pathname.length > 1) {
      const possibleUrl = url.pathname.substring(1) + url.search;
      if (possibleUrl.startsWith("http")) {
        targetUrl = possibleUrl;
      }
    }

    if (!targetUrl) {
      // The dev binding also works behind HTTPS tunnels, whose hostname is public.
      // Always connect to the local HTTP origin, never the incoming tunnel host.
      if (env.VITE_DEV_ORIGIN) {
        const viteUrl = new URL(request.url);
        const viteOrigin = new URL(env.VITE_DEV_ORIGIN);
        viteUrl.protocol = viteOrigin.protocol;
        viteUrl.host = viteOrigin.host;

        const viteHeaders = new Headers(request.headers);
        viteHeaders.delete("Host");

        return fetch(viteUrl.toString(), {
          method: request.method,
          headers: viteHeaders,
          body: (request.method !== "GET" && request.method !== "HEAD") ? request.body : null
        });
      }

      // 2. PRODUCTION: Serve compiled assets from Cloudflare Pages
      return await env.ASSETS.fetch(request.clone());
    }

    return fetchProxy(request, targetUrl, url.searchParams.get('mode') || 'json');
  }
};

// Keep this list in step with the TorBox operations used by the app.
const TORBOX_ROUTES = new Map([
  ['/v1/api/user/me', 'GET'],
  ['/v1/api/user/auth/device/start', 'GET'],
  ['/v1/api/user/auth/device/token', 'POST'],
  ['/v1/api/torrents/mylist', 'GET'],
  ['/v1/api/torrents/requestdl', 'GET'],
  ['/v1/api/torrents/createtorrent', 'POST'],
  ['/v1/api/torrents/controltorrent', 'POST'],
  ['/v1/api/torrents/edittorrent', 'PUT']
]);
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_ADDON_BYTES = 16 * 1024 * 1024;
const MAX_TORBOX_BYTES = 16 * 1024 * 1024;
const MAX_REDIRECTS = 5;

class ProxyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function jsonResponse(data, status = 200, retryAfter = null) {
  // Never copy upstream headers: cookies, redirects, cache directives, and active
  // content must not acquire the application's origin.
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Retry-After'
  });
  if (retryAfter) headers.set('Retry-After', retryAfter);
  return new Response(JSON.stringify(data), { status, headers });
}

function isPublicHostname(hostname) {
  // No IP literals (including WHATWG-normalized numeric/hex IPv4), single-label
  // hosts, trailing dots, or names reserved for private networks.
  return hostname.length <= 253
    && hostname.includes('.')
    && !/^\d+(\.\d+){3}$/.test(hostname)
    && !hostname.includes(':')
    && !/(^|\.)(localhost|local|internal|lan|home|test|invalid|example|onion|arpa)$/.test(hostname)
    && hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function validateDestination(rawUrl, request) {
  let target;
  try {
    if (rawUrl.length > 8192) throw new Error();
    target = new URL(rawUrl);
  } catch {
    throw new ProxyError(400, 'Invalid proxy URL.');
  }
  if (
    target.protocol !== 'https:' || target.port
    || target.username || target.password || target.hash
  ) {
    throw new ProxyError(403, 'Proxy destinations must use HTTPS on port 443 without URL credentials or fragments.');
  }
  if (!isPublicHostname(target.hostname) || target.hostname === new URL(request.url).hostname) {
    throw new ProxyError(403, 'Proxy destination is not permitted.');
  }

  const isTorbox = target.hostname === 'api.torbox.app';
  if (isTorbox) {
    const method = TORBOX_ROUTES.get(target.pathname);
    if (!method) throw new ProxyError(403, 'TorBox endpoint is not permitted.');
    if (request.method !== method) throw new ProxyError(405, 'Method is not permitted for this TorBox endpoint.');
  } else {
    if (!['GET', 'HEAD'].includes(request.method)) throw new ProxyError(405, 'Add-on requests only support GET and HEAD.');
  }
  return { target, isTorbox };
}

async function readLimitedBody(message, maxBytes, status, signal) {
  signal.throwIfAborted();
  const fail = () => new ProxyError(
    status,
    status === 413 ? 'Proxy request is too large.' : 'Upstream JSON response is too large.'
  );
  if (Number(message.headers.get('Content-Length')) > maxBytes) {
    await message.body?.cancel();
    throw fail();
  }
  if (!message.body) return new Uint8Array();
  const reader = message.body.getReader();
  const abortRead = () => {
    reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener('abort', abortRead, { once: true });
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw fail();
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', abortRead);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function isMediaType(contentType) {
  return !contentType || /^(?:video\/|audio\/|application\/(?:octet-stream|vnd\.apple\.mpegurl|x-mpegurl|dash\+xml)$)/i.test(contentType);
}

async function mediaResponse(request, target, upstream, signal) {
  const headers = new Headers({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox"
  });
  for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified']) {
    if (upstream.headers.has(name)) headers.set(name, upstream.headers.get(name));
  }
  let body = upstream.body;
  if (request.method === 'HEAD' || upstream.status === 416) {
    await upstream.body?.cancel();
    body = null;
    if (upstream.status === 416) headers.delete('Content-Length');
  } else if (/application\/(?:vnd\.apple\.mpegurl|x-mpegurl)/i.test(headers.get('Content-Type') || '')) {
    const bytes = await readLimitedBody(upstream, MAX_REQUEST_BYTES, 502, signal);
    const playlist = new TextDecoder().decode(bytes);
    const relay = value => mediaProxyUrl(request, new URL(value, target), '');
    body = playlist.replace(/URI="([^"]+)"/g, (_, value) => `URI="${relay(value)}"`)
      .replace(/^(?!#)(\S.*)$/gm, line => relay(line.trim()));
    headers.delete('Content-Length');
  }
  return new Response(body, {
    status: upstream.status, headers
  });
}

function resolvedMediaUrl(request, target, upstream, contentType) {
  const origin = request.headers.get('Origin') || new URL(request.url).origin;
  const allowedOrigin = upstream.headers.get('Access-Control-Allow-Origin');
  if (allowedOrigin === '*' || allowedOrigin === origin) return target.href;

  return mediaProxyUrl(request, target, contentType);
}

function mediaProxyUrl(request, target, contentType) {
  // Relay media that cannot be read directly by the browser. Keep byte ranges
  // and size headers available to the player without buffering the video.
  const proxy = new URL(request.url);
  let filename = target.pathname.split('/').pop() || 'video';
  if (/matroska/i.test(contentType)) filename = 'video.mkv';
  proxy.pathname = `/media/${encodeURIComponent(filename)}`;
  proxy.search = '';
  proxy.searchParams.set('url', target.href);
  proxy.searchParams.set('mode', 'media');
  return proxy.href;
}

async function fetchProxy(request, rawUrl, mode) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    if (!['json', 'resolve', 'media'].includes(mode)) throw new ProxyError(400, 'Invalid proxy mode.');
    if (mode !== 'json' && !['GET', 'HEAD'].includes(request.method)) {
      throw new ProxyError(405, 'Stream requests only support GET and HEAD.');
    }
    let { target, isTorbox } = validateDestination(rawUrl, request);
    const headers = new Headers({ Accept: mode === 'json' ? 'application/json' : '*/*' });
    if (isTorbox && request.headers.has('Authorization')) {
      headers.set('Authorization', request.headers.get('Authorization'));
    }
    if (mode === 'resolve') headers.set('Range', 'bytes=0-0');
    if (mode === 'media') {
      for (const name of ['Range', 'If-Range']) {
        if (request.headers.has(name)) headers.set(name, request.headers.get(name));
      }
    }
    let body;
    if (request.method === 'POST' || request.method === 'PUT') {
      const contentType = request.headers.get('Content-Type') || '';
      if (!/^(application\/json|application\/x-www-form-urlencoded|multipart\/form-data)(;|$)/i.test(contentType)) {
        throw new ProxyError(415, 'Unsupported request content type.');
      }
      headers.set('Content-Type', contentType);
      body = await readLimitedBody(request, MAX_REQUEST_BYTES, 413, controller.signal);
    }

    const visited = new Set();
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (mode === 'resolve' && isTorbox && target.pathname === '/v1/api/torrents/requestdl') {
        target.searchParams.delete('redirect');
        target.searchParams.set('zip', 'false');
      }
      if (visited.has(target.href)) throw new ProxyError(502, 'Upstream redirect loop.');
      visited.add(target.href);
      const upstream = await fetch(target.href, {
        method: request.method, headers, body, redirect: 'manual', signal: controller.signal
      });
      if (upstream.status >= 300 && upstream.status < 400 && upstream.status !== 304) {
        const location = upstream.headers.get('Location');
        await upstream.body?.cancel();
        if (!location) throw new ProxyError(502, 'Upstream redirect has no destination.');
        if (!['GET', 'HEAD'].includes(request.method)) throw new ProxyError(502, 'Redirects are only permitted for read requests.');
        ({ target, isTorbox } = validateDestination(new URL(location, target).href, request));
        headers.delete('Authorization');
        continue;
      }
      const contentType = upstream.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
      if (mode === 'media' && (upstream.status === 416 || isMediaType(contentType))) {
        return await mediaResponse(request, target, upstream, controller.signal);
      }
      if (mode === 'resolve' && upstream.ok && isMediaType(contentType)) {
        await upstream.body?.cancel();
        return jsonResponse({ success: true, data: resolvedMediaUrl(request, target, upstream, contentType) });
      }
      if (upstream.status === 204 || request.method === 'HEAD') {
        await upstream.body?.cancel();
        if (request.method === 'HEAD') return new Response(null, {
          status: upstream.status, headers: jsonResponse(null).headers
        });
        return jsonResponse(null, upstream.status === 204 ? 200 : upstream.status);
      }
      if (contentType && contentType !== 'text/plain'
          && !/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)$/.test(contentType)) {
        await upstream.body?.cancel();
        throw new ProxyError(502, 'Upstream did not return JSON or playable media.');
      }
      const bytes = await readLimitedBody(upstream, isTorbox ? MAX_TORBOX_BYTES : MAX_ADDON_BYTES, 502, controller.signal);
      let data;
      try {
        data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        throw new ProxyError(502, 'Upstream returned invalid JSON.');
      }
      if (mode === 'resolve' && upstream.ok && data?.success !== false) {
        const destination = typeof data === 'string' ? data
          : typeof data?.data === 'string' ? data.data : data?.url || data?.data?.url;
        if (typeof destination !== 'string') throw new ProxyError(502, 'The source did not return a playable URL.');
        ({ target, isTorbox } = validateDestination(new URL(destination, target).href, request));
        headers.delete('Authorization');
        continue;
      }
      return jsonResponse(data, upstream.status, upstream.headers.get('Retry-After'));
    }
    throw new ProxyError(502, 'Too many upstream redirects.');
  } catch (error) {
    if (error instanceof ProxyError) return jsonResponse({ error: error.message }, error.status);
    return jsonResponse(
      { error: controller.signal.aborted ? 'Proxy request timed out.' : 'Proxy fetch failed.' },
      controller.signal.aborted ? 504 : 502
    );
  } finally {
    clearTimeout(timer);
  }
}
