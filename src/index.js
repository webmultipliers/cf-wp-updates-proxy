const GITHUB_API = "https://api.github.com";

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

async function handleUpdatesJson(originUrl, config, headers, slug) {
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

  return json(manifest);
}

async function handleDownload(pathParts, config, headers) {
  if (pathParts.length < 4) {
    return json({ error: "Invalid download endpoint." }, 400);
  }

  const tag = pathParts[2];
  const filename = pathParts.slice(3).join("/");

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
        "cache-control": "no-store",
      },
    });
  }

  return json({ error: "Failed to fetch asset redirect." }, 500);
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

    if (parsed.action === "updates.json") {
      return handleUpdatesJson(url, config, headers, parsed.slug);
    }

    if (parsed.action === "download") {
      return handleDownload(parsed.pathParts, config, headers);
    }

    return json({ error: "Invalid endpoint." }, 400);
  },
};
