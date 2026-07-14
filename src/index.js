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

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
  if (status >= 200 && status < 300) {
    return true;
  }

  return status === 301 || status === 302 || status === 307 || status === 308;
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
  if (!bypassCache && isCacheableStatus(response.status)) {
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
      if (releaseResp.status === 404) {
        return json({ error: "Release not found", details: releaseResp.text }, 404);
      }

      return json({ error: "Failed to fetch release by tag", details: releaseResp.text }, releaseResp.status);
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

function buildPluginSummary(originUrl, slug, config, env) {
  const tokenConfigured = Boolean(config.tokenKey && env[config.tokenKey]);
  const isPrivate = Boolean(config.isPrivate);
  const preflightHealthy = !isPrivate || tokenConfigured;

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

async function buildServiceStatus(originUrl, env, includeRemoteChecks = true) {
  const routingResult = await getRoutingMap(env);
  if (routingResult.error) {
    return {
      ok: false,
      service: "cf-wp-updates-proxy",
      generatedAt: new Date().toISOString(),
      error: routingResult.error,
      statusCode: routingResult.status || 500,
      routesCount: 0,
      plugins: [],
    };
  }

  const routeEntries = Object.entries(routingResult.routes);
  const plugins = await Promise.all(
    routeEntries.map(([slug, config]) => buildPluginStatus(originUrl, slug, config, env, includeRemoteChecks)),
  );
  const healthyCount = plugins.filter((plugin) => plugin.healthy).length;

  return {
    ok: healthyCount === plugins.length,
    service: "cf-wp-updates-proxy",
    generatedAt: new Date().toISOString(),
    routesCount: plugins.length,
    healthyCount,
    unhealthyCount: plugins.length - healthyCount,
    mode: includeRemoteChecks ? "remote" : "preflight",
    plugins,
    docs: {
      statusPage: `${originUrl.origin}/status`,
      statusJson: `${originUrl.origin}/status.json`,
      updatesPattern: `${originUrl.origin}/<slug>/updates.json`,
      downloadPattern: `${originUrl.origin}/<slug>/download/<tag>/<filename>`,
    },
  };
}

function renderStatusPage(report) {
  const rows = report.plugins
    .map((plugin) => {
      const state = plugin.healthy ? "healthy" : "degraded";
      const latestTag = plugin.checks?.latestRelease?.tag || "-";
      const manifestVersion = plugin.checks?.manifest?.version || "-";
      const pkgCount = plugin.checks?.manifest?.packageCount ?? 0;
      const notes = (plugin.problems || []).join(" ") || "OK";

      return `
        <tr>
          <td>${escapeHtml(plugin.slug)}</td>
          <td>${escapeHtml(`${plugin.owner}/${plugin.repo}`)}</td>
          <td><span class="pill ${state}">${escapeHtml(state)}</span></td>
          <td>${escapeHtml(latestTag)}</td>
          <td>${escapeHtml(manifestVersion)}</td>
          <td>${escapeHtml(String(pkgCount))}</td>
          <td>${escapeHtml(notes)}</td>
        </tr>
      `;
    })
    .join("");

  const summaryClass = report.ok ? "healthy" : "degraded";
  const summaryText = report.ok ? "All plugin routes healthy" : "One or more plugin routes degraded";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>cf-wp-updates-proxy status</title>
    <style>
      :root {
        --bg: #0f172a;
        --panel: #111827;
        --text: #e5e7eb;
        --muted: #9ca3af;
        --ok: #16a34a;
        --bad: #dc2626;
        --line: #1f2937;
        --accent: #0ea5e9;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: ui-sans-serif, -apple-system, Segoe UI, Helvetica, Arial, sans-serif;
        background: radial-gradient(circle at 10% 10%, #111827, #0b1220 55%, #050816);
        color: var(--text);
      }
      .container {
        max-width: 1100px;
        margin: 0 auto;
        padding: 32px 20px 48px;
      }
      h1 { margin: 0 0 10px; font-size: 30px; }
      .muted { color: var(--muted); margin: 0 0 18px; }
      .summary {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        padding: 10px 14px;
        border: 1px solid var(--line);
        border-radius: 10px;
        background: var(--panel);
        margin-bottom: 18px;
      }
      .dot {
        width: 10px;
        height: 10px;
        border-radius: 999px;
      }
      .dot.healthy { background: var(--ok); }
      .dot.degraded { background: var(--bad); }
      table {
        width: 100%;
        border-collapse: collapse;
        overflow: hidden;
        border-radius: 12px;
        border: 1px solid var(--line);
        background: #0b1120cc;
      }
      th, td {
        text-align: left;
        padding: 12px;
        border-bottom: 1px solid var(--line);
        font-size: 14px;
        vertical-align: top;
      }
      th {
        color: var(--muted);
        font-weight: 600;
      }
      tr:last-child td { border-bottom: 0; }
      .pill {
        border-radius: 999px;
        padding: 4px 8px;
        font-size: 12px;
        border: 1px solid transparent;
      }
      .pill.healthy {
        color: #86efac;
        border-color: #166534;
        background: #052e16;
      }
      .pill.degraded {
        color: #fca5a5;
        border-color: #7f1d1d;
        background: #450a0a;
      }
      .links {
        margin-top: 16px;
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      a {
        color: var(--accent);
        text-decoration: none;
      }
      a:hover { text-decoration: underline; }
      code {
        color: #bfdbfe;
      }
    </style>
  </head>
  <body>
    <main class="container">
      <h1>cf-wp-updates-proxy status</h1>
      <p class="muted">Self-diagnostics for route health, release resolution, and manifest delivery.</p>
      <div class="summary">
        <span class="dot ${summaryClass}"></span>
        <strong>${escapeHtml(summaryText)}</strong>
        <span class="muted">(${escapeHtml(String(report.healthyCount || 0))}/${escapeHtml(String(report.routesCount || 0))} healthy)</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Slug</th>
            <th>Repository</th>
            <th>Status</th>
            <th>Latest Tag</th>
            <th>Manifest Version</th>
            <th>Packages</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="links">
        <a href="/status.json">Full JSON report</a>
        <a href="/status.json?check=0">Preflight-only JSON</a>
      </div>
      <p class="muted">Generated at: <code>${escapeHtml(report.generatedAt || "-")}</code></p>
    </main>
  </body>
</html>`;
}

export default {
  async fetch(request, env) {
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405, { allow: "GET" });
    }

    const url = new URL(request.url);
    if (url.pathname === "/") {
      const includeRemoteChecks = url.searchParams.get("check") !== "0";
      const report = await buildServiceStatus(url, env, includeRemoteChecks);
      const statusCode = report.ok ? 200 : (report.statusCode || 503);
      return html(renderStatusPage(report), statusCode);
    }

    if (url.pathname === "/status" || url.pathname === "/status/") {
      const includeRemoteChecks = url.searchParams.get("check") !== "0";
      const report = await buildServiceStatus(url, env, includeRemoteChecks);
      const statusCode = report.ok ? 200 : (report.statusCode || 503);
      return html(renderStatusPage(report), statusCode);
    }

    if (url.pathname === "/status.json") {
      const includeRemoteChecks = url.searchParams.get("check") !== "0";
      const report = await buildServiceStatus(url, env, includeRemoteChecks);
      const statusCode = report.ok ? 200 : (report.statusCode || 503);
      return json(report, statusCode);
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

    if (parsed.action === "status.json") {
      const includeRemoteChecks = url.searchParams.get("check") !== "0";
      const pluginStatus = await buildPluginStatus(url, parsed.slug, config, env, includeRemoteChecks);
      const statusCode = pluginStatus.healthy ? 200 : 503;
      return json(pluginStatus, statusCode);
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
