const GITHUB_API = "https://api.github.com";
const DEFAULT_MANIFEST_CACHE_TTL_SECONDS = 6 * 60 * 60;
const DEFAULT_DOWNLOAD_CACHE_TTL_SECONDS = 24 * 60 * 60;
const STATUS_REMOTE_CHECK_CACHE_TTL_SECONDS = 60;

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

const HOME_PAGE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>cf-wp-updates-proxy</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        font-family: ui-sans-serif, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
        line-height: 1.5;
      }
      main {
        max-width: 640px;
        margin: 0 auto;
        padding: 48px 20px;
      }
      h1 { font-size: 1.5rem; margin-bottom: 0.25em; }
      .tagline { opacity: 0.75; margin-top: 0; }
      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.9em;
        background: rgba(127, 127, 127, 0.15);
        padding: 0.15em 0.4em;
        border-radius: 4px;
      }
      table { border-collapse: collapse; width: 100%; margin: 1.5em 0; }
      th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid rgba(127, 127, 127, 0.3); vertical-align: top; font-size: 0.92em; }
      th { opacity: 0.7; font-weight: 600; }
      footer { opacity: 0.6; font-size: 0.85em; margin-top: 2em; }
    </style>
  </head>
  <body>
    <main>
      <h1>cf-wp-updates-proxy</h1>
      <p class="tagline">Serves WordPress plugin update manifests and package downloads backed by GitHub Releases.</p>
      <table>
        <thead>
          <tr><th>Endpoint</th><th>Purpose</th></tr>
        </thead>
        <tbody>
          <tr><td><code>GET /&lt;slug&gt;/updates.json</code></td><td>Update manifest for a configured route</td></tr>
          <tr><td><code>GET /&lt;slug&gt;/download/&lt;tag&gt;/&lt;filename&gt;</code></td><td>Streamed package download</td></tr>
          <tr><td><code>GET /&lt;slug&gt;/status.json</code></td><td>Per-route health check</td></tr>
        </tbody>
      </table>
      <footer>This page lists endpoint patterns only — configured plugin slugs are not enumerated here. See this deployment's repository README for the full behavior contract and configuration reference.</footer>
    </main>
  </body>
</html>`;

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}

function sanitizeFilename(filename) {
  return String(filename)
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replaceAll('"', "");
}

function buildGithubHeaders(config, env) {
  const headers = {
    "user-agent": "Cloudflare-Worker-WP-Updater",
    accept: "application/vnd.github+json",
  };

  const token = (config.tokenKey && env[config.tokenKey]) || env.GITHUB_PAT_DEFAULT;
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  return headers;
}

function parseRoute(url) {
  const pathParts = url.pathname.split("/").filter(Boolean);
  if (pathParts.length < 2) {
    return null;
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

function isCacheableStatus(status) {
  return status >= 200 && status < 300;
}

async function withCache(cacheKey, ttlSeconds, computeResponse, bypassCache, ctx) {
  const cache = caches.default;
  if (!bypassCache) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const response = await computeResponse();
  if (isCacheableStatus(response.status)) {
    const cloned = response.clone();
    cloned.headers.set("cache-control", `public, max-age=${ttlSeconds}`);
    ctx.waitUntil(cache.put(cacheKey, cloned));
  }

  return response;
}

async function handleUpdatesJson(originUrl, config, headers, slug, env, bypassCache, ctx) {
  const manifestTtl = parsePositiveInt(
    env.MANIFEST_CACHE_TTL_SECONDS,
    DEFAULT_MANIFEST_CACHE_TTL_SECONDS,
  );
  const cacheKey = new Request(`${originUrl.origin}/${slug}/updates.json`, { method: "GET" });

  return withCache(cacheKey, manifestTtl, async () => {
    const latestUrl = `${GITHUB_API}/repos/${config.owner}/${config.repo}/releases/latest`;
    const latestResp = await fetchJson(latestUrl, headers);

    if (!latestResp.ok) {
      console.error(`Failed to fetch latest release for ${slug}: ${latestResp.status} ${latestResp.text}`);
      return json({ error: "Failed to fetch latest release." }, latestResp.status);
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
      console.error(`Failed to fetch manifest for ${slug}: ${manifestResp.status} ${await manifestResp.text()}`);
      return json({ error: "Failed to fetch manifest." }, manifestResp.status);
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
  }, bypassCache, ctx);
}

async function handleDownload(originUrl, pathParts, config, headers, env, bypassCache, ctx) {
  if (pathParts.length < 4) {
    return json({ error: "Invalid download endpoint." }, 400);
  }

  const tag = pathParts[2];
  const filename = sanitizeFilename(pathParts.slice(3).join("/"));
  const downloadTtl = parsePositiveInt(
    env.DOWNLOAD_CACHE_TTL_SECONDS,
    DEFAULT_DOWNLOAD_CACHE_TTL_SECONDS,
  );
  const cacheKey = new Request(`${originUrl.origin}/${pathParts.join("/")}`, { method: "GET" });

  return withCache(cacheKey, downloadTtl, async () => {
    const releaseByTagUrl = `${GITHUB_API}/repos/${config.owner}/${config.repo}/releases/tags/${encodeURIComponent(tag)}`;
    const releaseResp = await fetchJson(releaseByTagUrl, headers);

    if (!releaseResp.ok) {
      console.error(`Failed to fetch release ${tag} for download: ${releaseResp.status} ${releaseResp.text}`);
      if (releaseResp.status === 404) {
        return json({ error: "Release not found" }, 404);
      }

      return json({ error: "Failed to fetch release by tag." }, releaseResp.status);
    }

    const releaseData = releaseResp.data;
    const zipAsset = releaseData.assets?.find((asset) => asset.name === filename);

    if (!zipAsset) {
      return json({ error: "Asset not found" }, 404);
    }

    const assetResp = await fetch(zipAsset.url, {
      headers: { ...headers, accept: "application/octet-stream" },
      redirect: "follow",
    });

    if (!assetResp.ok) {
      console.error(`Failed to fetch asset ${filename} for ${tag}: ${assetResp.status}`);
      return json({ error: "Failed to fetch asset." }, 502);
    }

    return new Response(assetResp.body, {
      status: 200,
      headers: {
        "content-type": zipAsset.content_type || "application/zip",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": `public, max-age=${downloadTtl}`,
      },
    });
  }, bypassCache, ctx);
}

async function handleStatusJson(originUrl, slug, config, env, includeRemoteChecks, bypassCache, ctx) {
  if (!includeRemoteChecks) {
    const pluginStatus = await buildPluginStatus(originUrl, slug, config, env, false);
    return json(pluginStatus, pluginStatus.healthy ? 200 : 503);
  }

  // Remote checks make several authenticated GitHub API calls per request; cache
  // briefly so a known slug can't be hammered to burn the PAT's rate limit. Unlike
  // withCache(), this caches 503s too — a degraded route is exactly the case
  // where repeated hits are cheapest to trigger and most worth capping, and 60s
  // of staleness on a diagnostic endpoint isn't misleading.
  const cache = caches.default;
  const cacheKey = new Request(`${originUrl.origin}/${slug}/status.json`, { method: "GET" });

  if (!bypassCache) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const pluginStatus = await buildPluginStatus(originUrl, slug, config, env, true);
  const response = json(pluginStatus, pluginStatus.healthy ? 200 : 503, {
    "cache-control": `public, max-age=${STATUS_REMOTE_CHECK_CACHE_TTL_SECONDS}`,
  });

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

function buildPluginSummary(originUrl, slug, config, env) {
  const tokenConfigured = Boolean((config.tokenKey && env[config.tokenKey]) || env.GITHUB_PAT_DEFAULT);
  const isPrivate = Boolean(config.isPrivate);
  const preflightHealthy = !isPrivate || Boolean(config.tokenKey && env[config.tokenKey]);

  return {
    slug,
    owner: config.owner,
    repo: config.repo,
    isPrivate,
    tokenKey: config.tokenKey || null,
    tokenConfigured,
    preflightHealthy,
    endpoints: {
      updates: `${originUrl.origin}/${slug}/updates.json`,
      status: `${originUrl.origin}/${slug}/status.json`,
      downloadTemplate: `${originUrl.origin}/${slug}/download/<tag>/<filename>`,
    },
  };
}

async function buildPluginStatus(originUrl, slug, config, env, includeRemoteChecks = true) {
  const summary = buildPluginSummary(originUrl, slug, config, env);

  if (!includeRemoteChecks) {
    return {
      ...summary,
      healthy: summary.preflightHealthy,
      checks: {
        mode: "preflight",
      },
    };
  }

  const checks = {
    mode: "remote",
    repo: { ok: false, status: null },
    latestRelease: { ok: false, status: null, tag: null, hasManifestAsset: false },
    manifest: {
      ok: false,
      status: null,
      version: null,
      packageCount: 0,
      rewrittenPackages: [],
    },
  };

  if (!summary.preflightHealthy) {
    return {
      ...summary,
      healthy: false,
      checks,
      problems: [
        `Missing secret for private plugin: ${summary.tokenKey || "undefined tokenKey"}`,
      ],
    };
  }

  const headers = buildGithubHeaders(config, env);
  const problems = [];
  const repoUrl = `${GITHUB_API}/repos/${config.owner}/${config.repo}`;
  const repoResp = await fetchJson(repoUrl, headers);
  checks.repo.status = repoResp.status;
  checks.repo.ok = repoResp.ok;
  if (!repoResp.ok) {
    problems.push(`Repository lookup failed (${repoResp.status}).`);
  }

  const latestUrl = `${GITHUB_API}/repos/${config.owner}/${config.repo}/releases/latest`;
  const latestResp = await fetchJson(latestUrl, headers);
  checks.latestRelease.status = latestResp.status;
  checks.latestRelease.ok = latestResp.ok;

  if (!latestResp.ok) {
    problems.push(`Latest release lookup failed (${latestResp.status}).`);
    return {
      ...summary,
      healthy: false,
      checks,
      problems,
    };
  }

  const releaseData = latestResp.data;
  const tag = releaseData.tag_name || null;
  const manifestAsset = releaseData.assets?.find((asset) => asset.name === "updates.json");

  checks.latestRelease.tag = tag;
  checks.latestRelease.hasManifestAsset = Boolean(manifestAsset);

  if (!manifestAsset) {
    problems.push("updates.json asset not found in latest release.");
    return {
      ...summary,
      healthy: false,
      checks,
      problems,
    };
  }

  const manifestResp = await fetch(manifestAsset.url, {
    headers: {
      ...headers,
      accept: "application/octet-stream",
    },
    redirect: "follow",
  });

  checks.manifest.status = manifestResp.status;
  checks.manifest.ok = manifestResp.ok;

  if (!manifestResp.ok) {
    problems.push(`Manifest download failed (${manifestResp.status}).`);
    return {
      ...summary,
      healthy: false,
      checks,
      problems,
    };
  }

  const manifest = await manifestResp.json();
  const packages = Array.isArray(manifest.packages) ? manifest.packages : [];
  checks.manifest.version = manifest.version || null;
  checks.manifest.packageCount = packages.length;
  checks.manifest.rewrittenPackages = packages.map((pkg) => {
    const currentPackage = typeof pkg.package === "string" ? pkg.package : "";
    const filename = currentPackage.split("/").pop();
    const rewrittenUrl = filename && tag
      ? `${originUrl.origin}/${slug}/download/${tag}/${filename}`
      : null;

    return {
      variant: pkg.variant || null,
      filename: filename || null,
      rewrittenUrl,
      checksum: pkg.checksum || null,
      size: pkg.size || null,
    };
  });

  return {
    ...summary,
    healthy: problems.length === 0,
    checks,
    problems,
  };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405, { allow: "GET" });
    }

    const url = new URL(request.url);
    if (url.pathname === "/") {
      return html(HOME_PAGE_HTML);
    }

    const parsed = parseRoute(url);

    // Treat malformed paths as not found to avoid noisy format errors.
    if (!parsed) {
      return json({ error: "Not found." }, 404);
    }

    const routingResult = await getRoutingMap(env);
    if (routingResult.error) {
      return json({ error: routingResult.error }, routingResult.status || 500);
    }

    const config = routingResult.routes[parsed.slug];
    if (!config) {
      return json({ error: "Plugin routing not found." }, 404);
    }

    const bypassState = getCacheBypassState(env, request, url);
    if (bypassState.error) {
      return json({ error: bypassState.error }, bypassState.status || 403);
    }

    const bypassCache = bypassState.bypassCache;

    if (parsed.action === "status.json") {
      const includeRemoteChecks = url.searchParams.get("check") !== "0";
      return handleStatusJson(url, parsed.slug, config, env, includeRemoteChecks, bypassCache, ctx);
    }

    if (config.isPrivate && (!config.tokenKey || !env[config.tokenKey])) {
      return json(
        { error: `Missing secret for private plugin: ${config.tokenKey || "undefined tokenKey"}` },
        500,
      );
    }

    const headers = buildGithubHeaders(config, env);

    if (parsed.action === "updates.json") {
      return handleUpdatesJson(url, config, headers, parsed.slug, env, bypassCache, ctx);
    }

    if (parsed.action === "download") {
      return handleDownload(url, parsed.pathParts, config, headers, env, bypassCache, ctx);
    }

    return json({ error: "Invalid endpoint." }, 400);
  },
};
