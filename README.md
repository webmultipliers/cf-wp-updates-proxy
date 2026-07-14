# cf-wp-updates-proxy

A Cloudflare Worker that serves WordPress plugin update manifests and package
downloads backed by GitHub Releases. It routes and injects secrets; nothing
else. All configuration — which repos map to which slugs, tokens, cache
TTLs — lives in Cloudflare KV, Worker secrets, and Worker vars. The source in
`src/` is never edited to configure a deployment.

This repository is a GitHub template. Click "Use this template," bind a KV
namespace, write a `routes` key, set secrets, and deploy.

## Behavior contract

All endpoints are `GET` only; any other method returns `405`.

### `GET /`

Returns a small JSON identity document listing the endpoint patterns below.
Not cached.

### `GET /<slug>/updates.json`

Resolves the route's latest GitHub release, fetches the release asset named
`updates.json`, rewrites every `packages[].package` URL to
`/<slug>/download/<tag>/<filename>`, and returns the manifest.

- **200** — manifest JSON, `cache-control: public, max-age=<MANIFEST_CACHE_TTL_SECONDS>`
- **404** — unknown slug, or the latest release has no `updates.json` asset
- **500** — `CONFIG_KV` binding or `routes` key missing/invalid; or the route
  is `isPrivate: true` and its `tokenKey` secret isn't set
- **502** — upstream GitHub request failed (status passed through where GitHub
  provided one)

Cached at the edge for `MANIFEST_CACHE_TTL_SECONDS` (default `21600`, 6h),
keyed by the full request path.

### `GET /<slug>/download/<tag>/<filename>`

Resolves the release matching `<tag>`, finds the asset named `<filename>`,
and streams its body directly — it never redirects to GitHub's signed asset
URL (those expire in minutes, which would poison a longer-lived cache).

- **200** — asset body, `content-type: application/zip`,
  `content-disposition: attachment`, `cache-control: public, max-age=<DOWNLOAD_CACHE_TTL_SECONDS>`
- **404** — unknown slug, unknown release tag, or no asset named `<filename>`
  in that release
- **500** — same KV/secret failure modes as above
- **502** — GitHub returned a non-OK response for the asset fetch

Cached at the edge for `DOWNLOAD_CACHE_TTL_SECONDS` (default `86400`, 24h).
This is safe because a `<tag>/<filename>` pair is immutable — a given tag
never gets new content under the same filename.

### `GET /<slug>/status.json`

Per-route health report. Does not require or expose fleet-wide data — each
slug's health is queried independently.

- **200** — route is healthy
- **503** — route is degraded (see `problems[]` in the response body)
- **404** — unknown slug

Add `?check=0` to skip GitHub calls and return only preflight checks (KV
config and secret presence). Never cached.

### Cache bypass

Any manifest or download request may include `?refresh=1` (or `?no_cache=1`)
when `ALLOW_CACHE_BYPASS=true`. If `CACHE_BYPASS_TOKEN` is set, the request
must also carry a matching `x-cache-bypass-token` header, or it gets `403`.

A bypass request skips the cache **read** but still **writes** the fresh
response to the edge cache. This lets a CI step force-refresh the cache right
after publishing a release, without leaving the cache cold for the next
normal request:

```bash
curl -H "x-cache-bypass-token: <token>" \
  "https://updates.example.com/example-plugin/updates.json?refresh=1"
```

## Configuration reference

### KV: `routes` key

Bind a KV namespace as `CONFIG_KV` and write a JSON object to the key
`routes`. Each entry maps a slug (used in the URL path) to a GitHub repo:

```json
{
  "example-plugin": {
    "owner": "example-org",
    "repo": "example-plugin",
    "tokenKey": null,
    "isPrivate": false
  },
  "example-private-plugin": {
    "owner": "example-org",
    "repo": "example-private-plugin",
    "tokenKey": "GITHUB_PAT_EXAMPLE_PRIVATE_PLUGIN",
    "isPrivate": true
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `owner` | string | GitHub org/user that owns the repo. |
| `repo` | string | Repository name (no `owner/` prefix). |
| `tokenKey` | string \| `null` | Name of the Worker secret holding this route's GitHub token. `null` to rely on `GITHUB_PAT_DEFAULT`. |
| `isPrivate` | boolean | If `true`, `tokenKey` must resolve to a set secret or the route returns `500`. |

See `routes.example.json` in this repo for a ready-to-load example (public +
private).

### Vars and secrets

| Name | Kind | Default | Purpose |
| --- | --- | --- | --- |
| `MANIFEST_CACHE_TTL_SECONDS` | var | `21600` | Edge cache TTL for `updates.json` responses. |
| `DOWNLOAD_CACHE_TTL_SECONDS` | var | `86400` | Edge cache TTL for streamed download responses. |
| `ALLOW_CACHE_BYPASS` | var | `false` | Enables `?refresh=1` / `?no_cache=1`. |
| `CACHE_BYPASS_TOKEN` | var | unset | If set, required as `x-cache-bypass-token` on bypass requests. |
| `GITHUB_PAT_DEFAULT` | secret | unset | Shared token used when a route has no `tokenKey`. **Strongly recommended for every deployment** — anonymous GitHub API calls from Workers share egress IPs across all Cloudflare customers and rate-limit unpredictably (60/hr/IP). |
| `GITHUB_PAT_*` | secret | unset | Per-route token; the name is whatever that route's `tokenKey` specifies. |

## Release convention

A compliant GitHub release needs:

- A tag (`tag_name`), used verbatim in download URLs.
- An asset literally named `updates.json` — the manifest this worker serves
  and rewrites.
- One or more package zip assets, referenced by `packages[].package` in the
  manifest (checksums, if present, pass through untouched).

Minimal `updates.json`:

```json
{
  "version": "1.2.0",
  "packages": [
    {
      "variant": "default",
      "package": "https://github.com/example-org/example-plugin/releases/download/v1.2.0/example-plugin.zip",
      "checksum": "sha256:...",
      "size": 123456
    }
  ]
}
```

The worker rewrites `package` to
`https://updates.example.com/example-plugin/download/v1.2.0/example-plugin.zip`
before returning the manifest — the original GitHub URL is never exposed to
clients.

## Deployment

**Template flow (recommended):**

1. Click "Use this template" to create your own repository.
2. In the new repo's Settings → Secrets and variables → Actions, set:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
   - `CONFIG_KV_NAMESPACE_ID` — the id of a KV namespace you've created and
     will bind as `CONFIG_KV`
3. Push to `main`. `.github/workflows/deploy.yml` builds a temporary config
   injecting the `CONFIG_KV` binding and deploys with `wrangler deploy`. If
   `CLOUDFLARE_API_TOKEN` isn't set yet, the workflow exits cleanly with a
   notice instead of failing.
4. Write your `routes` key and secrets (see above) via the Cloudflare
   dashboard or `wrangler kv` / `wrangler secret` from your machine.

**Manual alternative:**

```bash
npm install
npx wrangler kv namespace create CONFIG_KV
# bind the resulting id to this Worker as CONFIG_KV in the dashboard,
# or add a [[kv_namespaces]] block to a local, untracked config
npx wrangler deploy
```

### Local development

`wrangler.toml` intentionally has no `CONFIG_KV` binding (production gets one
injected at deploy time — see above), so local dev needs its own temporary
config with a placeholder binding, the same pattern the deploy workflow uses:

```bash
cp .dev.vars.example .dev.vars   # fill in placeholder tokens
cp wrangler.toml wrangler.dev.toml
printf '\n[[kv_namespaces]]\nbinding = "CONFIG_KV"\nid = "local"\n' >> wrangler.dev.toml

npx wrangler kv key put routes --binding CONFIG_KV --local \
  --config wrangler.dev.toml --path routes.example.json

npx wrangler dev --config wrangler.dev.toml
```

`wrangler.dev.toml` is gitignored — don't commit it.

## Operational requirements

- **The Cache API is inert on `*.workers.dev` domains.** Edge caching (and
  therefore the TTLs and bypass behavior documented above) only takes effect
  when the Worker is reached through a custom domain or route. Every example
  URL in this README uses a placeholder custom domain
  (`updates.example.com`) for this reason — replace it with your own.
- **`isPrivate: true` describes the GitHub repo, not the download.** A
  private route still serves its manifest and assets to anyone who requests
  the right slug/tag/filename — the worker has no concept of licensing or
  per-client authorization. If you need to restrict who can download, put
  that logic in front of this worker; it is explicitly out of scope here.

## Out of scope

This worker only does routing and secret injection. It does not include a
management CLI, a fleet-wide status dashboard, license validation, checksum
enforcement, release channels, or cache-warming automation. Build those as
separate tools against the endpoints documented above.
