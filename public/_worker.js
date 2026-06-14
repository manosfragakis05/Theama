export default {
  async fetch(request, env, ctx) {

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
          "Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers") || "*",
        }
      });
    }

    if (url.pathname === '/sw.js') {
      const response = await env.ASSETS.fetch(request);
      const modifiedResponse = new Response(response.body, response);
      modifiedResponse.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      modifiedResponse.headers.set('Pragma', 'no-cache');
      modifiedResponse.headers.set('Expires', '0');
      return modifiedResponse;
    }

    const url = new URL(request.url);

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

        const match = mappings.find(item => {
          const tmdbField = item.themoviedb_id || item.tmdb_id;
          if (!tmdbField) return false;
          if (typeof tmdbField !== "object") {
            return String(tmdbField) === tmdbIdParam;
          }
          return String(tmdbField.tv) === tmdbIdParam || String(tmdbField.movie) === tmdbIdParam;
        });

        if (match) {
          return new Response(JSON.stringify({
            tmdb_id: parseInt(tmdbIdParam, 10),
            anilist_id: match.anilist_id || null,
            kitsu_id: match.kitsu_id || null,
            type: match.type || "UNKNOWN"
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
      return env.ASSETS.fetch(request);
    }

    const proxyHeaders = new Headers(request.headers);
    proxyHeaders.delete("Origin");
    proxyHeaders.delete("Referer");
    proxyHeaders.delete("Host");

    const proxyRequest = new Request(targetUrl, {
      method: request.method,
      headers: proxyHeaders,
      body: (request.method !== "GET" && request.method !== "HEAD") ? request.body : null,
      redirect: "follow"
    });

    try {
      const proxyResponse = await fetch(proxyRequest);

      const finalResponse = new Response(proxyResponse.body, proxyResponse);
      finalResponse.headers.set("Access-Control-Allow-Origin", "*");
      finalResponse.headers.set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");

      return finalResponse;
    } catch (error) {
      return new Response(JSON.stringify({ error: "Proxy Fetch Error", details: error.message }), {
        status: 502,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
  }
};