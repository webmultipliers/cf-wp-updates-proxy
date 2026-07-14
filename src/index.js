const GITHUB_API = "https://api.github.com";
const DEFAULT_MANIFEST_CACHE_TTL_SECONDS = 6 * 60 * 60;
const DEFAULT_DOWNLOAD_REDIRECT_CACHE_TTL_SECONDS = 15 * 60;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      ...extraHeaders,
    },
  });
}

function buildGithubHeaders(config, env) {
  const headers = {
    "user-agent": "Cloudflare-Worker-WP-Updater",
    accept: "application/vnd.github+json",
  };

  if (config.tokenKey && env[config.tokenKey]) {
    headers.authorization = `Bearer ${env[config.tokenKey]}`;
  }

  return headers;
}

function parseRoute(url) {
  const pathParts = url.pathname.split("/").filter(Boolean);
  if (pathParts.length < 2) {
    return { error: "Invalid request format. Expected /<slug>/<action>" };
  }

  const slug = pathParts[0];
  const action = pathParts[1];
  return { slug, action, pathParts };
}

async function fetchJson(url, headers) {
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    return {
      ok: false,
      status: resp.status,
      text: await resp.text(),
    };
  }

  return {
    ok: true,
    status: resp.status,
    data: await resp.json(),
  };
}

async function getRoutingMap(env) {
  if (!env.CONFIG_KV || typeof env.CONFIG_KV.get !== "function") {
    return {
      error: "CONFIG_KV binding is missing. Bind your KV namespace as CONFIG_KV.",
      status: 500,
    };
  }

  const routes = await env.CONFIG_KV.get("routes", { type: "json" });
  if (!routes || typeof routes !== "object") {
    return {
      error: "System routing configuration missing or invalid in KV key 'routes'.",
      status: 500,
    };
  }

  return { routes };
}

function parsePositiveInt(value, fallback) {
  const num = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function getCacheBypassState(env, request, url) {
  const allowBypass = String(env.ALLOW_CACHE_BYPASS ?? "false").toLowerCase() === "true";
  if (!allowBypass) {
    return { bypassCache: false };
  }

  const bypassParam = url.searchParams.get("refresh") || url.searchParams.get("no_cache");
  const bypassRequested = bypassParam === "1" || String(bypassParam).toLowerCase() === "true";
  if (!bypassRequested) {
    return { bypassCache: false };
  }

  const expectedToken = String(env.CACHE_BYPASS_TOKEN ?? "").trim();
  if (!expectedToken) {
    return { bypassCache: true };
  }

  const providedToken = String(request.headers.get("x-cache-bypass-token") ?? "").trim();
  if (providedToken === expectedToken) {
    return { bypassCache: true };
  }

  return {
    error: "Unauthorized cache bypass request.",
    status: 403,
  };
}

async function withCache(cacheKey, ttlSeconds, computeResponse, bypassCache = false) {
  const cache = caches.default;
  if (!bypassCache) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const response = await computeResponse();
  if (!bypassCache && response.ok) {
    const cloned = response.clone();
    cloned.headers.set("cache-control", `public, max-age=${ttlSeconds}`);
    await cache.put(cacheKey, cloned);
  }

  return response;
}

async function handleUpdatesJson(originUrl, config, headers, slug, env, bypassCache) {
  const manifestTtl = parsePositiveInt(
    env.MANIFEST_CACHE_TTL_SECONDS,
    DEFAULT_MANIFEST_CACHE_TTL_SECONDS,
  );
  const cacheKey = new Request(`${originUrl.origin}/${slug}/updates.json`, { method: "GET" });

  return withCache(cacheKey, manifestTtl, async () => {
    const latestUrl = `${GITHUB_API}/repos/${config.owner}/${config.repo}/releases/latest`;
    const latestResp = await fetchJson(latestUrl, headers);

    if (!latestResp.ok) {
      return json(
        { error: `Failed to fetch latest release`, details: latestResp.text },
        latestResp.status,
      );
    }

    const releaseData = latestResp.data;
    const manifestAsset = releaseData.assets?.find((asset) => asset.name === "updates.json");

    if (!manifestAsset) {
      return json({ error: "Manifest not found in release" }, 404);
    }

    const manifestResp = await fetch(manifestAsset.url, {
      headers: {
        ...headers,
        accept: "application/octet-stream",
      },
      redirect: "follow",
    });

    if (!manifestResp.ok) {
      return json(
        { error: "Failed to fetch manifest", details: await manifestResp.text() },
        manifestResp.status,
      );
    }

    const manifest = await manifestResp.json();
    const tag = releaseData.tag_name;

    if (Array.isArray(manifest.packages)) {
      manifest.packages = manifest.packages.map((pkg) => {
        const currentPackage = typeof pkg.package === "string" ? pkg.package : "";
        const filename = currentPackage.split("/").pop();

        if (!filename) {
          return pkg;
        }

        return {
          ...pkg,
          package: `${originUrl.origin}/${slug}/download/${tag}/${filename}`,
        };
      });
    }

    return json(manifest, 200, { "cache-control": `public, max-age=${manifestTtl}` });
  }, bypassCache);
}

async function handleDownload(originUrl, pathParts, config, headers, env, bypassCache) {
  if (pathParts.length < 4) {
    return json({ error: "Invalid download endpoint." }, 400);
  }

  const tag = pathParts[2];
  const filename = pathParts.slice(3).join("/");
  const redirectTtl = parsePositiveInt(
    env.DOWNLOAD_REDIRECT_CACHE_TTL_SECONDS,
    DEFAULT_DOWNLOAD_REDIRECT_CACHE_TTL_SECONDS,
  );
  const cacheKey = new Request(`${originUrl.origin}/${pathParts.join("/")}`, { method: "GET" });

  return withCache(cacheKey, redirectTtl, async () => {
    const releaseByTagUrl = `${GITHUB_API}/repos/${config.owner}/${config.repo}/releases/tags/${encodeURIComponent(tag)}`;
    const releaseResp = await fetchJson(releaseByTagUrl, headers);

    if (!releaseResp.ok) {
      return json({ error: "Release not found", details: releaseResp.text }, 404);
    }

    const releaseData = releaseResp.data;
    const zipAsset = releaseData.assets?.find((asset) => asset.name === filename);

    if (!zipAsset) {
      return json({ error: "Asset not found" }, 404);
    }

    const assetResp = await fetch(zipAsset.url, {
      method: "GET",
      headers: {
        ...headers,
        accept: "application/octet-stream",
      },
      redirect: "manual",
    });

    if (assetResp.status === 301 || assetResp.status === 302) {
      const location = assetResp.headers.get("location");
      if (!location) {
        return json({ error: "Missing redirect location from GitHub asset" }, 502);
      }

      return new Response(null, {
        status: assetResp.status,
        headers: {
          location,
          "cache-control": `public, max-age=${redirectTtl}`,
        },
      });
    }

    return json({ error: "Failed to fetch asset redirect." }, 500);
  }, bypassCache);
}

export default {
  async fetch(request, env) {
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405, { allow: "GET" });
    }

    const url = new URL(request.url);
    const parsed = parseRoute(url);

    if (parsed.error) {
      return json({ error: parsed.error }, 400);
    }

    const routingResult = await getRoutingMap(env);
    if (routingResult.error) {
      return json({ error: routingResult.error }, routingResult.status || 500);
    }

    const config = routingResult.routes[parsed.slug];
    if (!config) {
      return json({ error: "Plugin routing not found." }, 404);
    }

    if (config.isPrivate && (!config.tokenKey || !env[config.tokenKey])) {
      return json(
        { error: `Missing secret for private plugin: ${config.tokenKey || "undefined tokenKey"}` },
        500,
      );
    }

    const headers = buildGithubHeaders(config, env);
    const bypassState = getCacheBypassState(env, request, url);
    if (bypassState.error) {
      return json({ error: bypassState.error }, bypassState.status || 403);
    }

    const bypassCache = bypassState.bypassCache;

    if (parsed.action === "updates.json") {
      return handleUpdatesJson(url, config, headers, parsed.slug, env, bypassCache);
    }

    if (parsed.action === "download") {
      return handleDownload(url, parsed.pathParts, config, headers, env, bypassCache);
    }

    return json({ error: "Invalid endpoint." }, 400);
  },
};
