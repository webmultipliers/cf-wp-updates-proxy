const GITHUB_API = "https://api.github.com";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function getRepoTarget(url) {
  const owner = url.searchParams.get("owner");
  const repo = url.searchParams.get("repo");

  if (!owner || !repo) {
    return { error: "Missing required query params: owner and repo" };
  }

  return { owner, repo };
}

async function fetchReleases(owner, repo, token) {
  const releaseUrl = `${GITHUB_API}/repos/${owner}/${repo}/releases?per_page=1`;

  const releaseResp = await fetch(releaseUrl, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "cf-wp-updates-proxy",
    },
  });

  if (!releaseResp.ok) {
    const details = await releaseResp.text();
    return {
      error: `GitHub API error (${releaseResp.status})`,
      details,
      status: releaseResp.status,
    };
  }

  const releases = await releaseResp.json();
  const latest = Array.isArray(releases) ? releases[0] : null;

  if (!latest) {
    return { error: "No releases found for repository", status: 404 };
  }

  const zipball = latest.assets?.find((asset) => asset.name.endsWith(".zip"));

  return {
    version: latest.tag_name,
    requires: "6.0",
    tested: "6.6",
    package: zipball?.browser_download_url || latest.zipball_url,
    last_updated: latest.published_at,
    homepage: `https://github.com/${owner}/${repo}`,
  };
}

export default {
  async fetch(request, env) {
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405, { allow: "GET" });
    }

    const token = env.GITHUB_PAT;
    if (!token) {
      return json({ error: "Server misconfiguration: GITHUB_PAT missing" }, 500);
    }

    const url = new URL(request.url);
    const target = getRepoTarget(url);

    if (target.error) {
      return json({ error: target.error }, 400);
    }

    const result = await fetchReleases(target.owner, target.repo, token);

    if (result.error) {
      return json({ error: result.error, details: result.details }, result.status || 500);
    }

    return json(result);
  },
};
