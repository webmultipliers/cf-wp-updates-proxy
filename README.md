# cf-wp-updates-proxy

Cloudflare Worker that proxies GitHub release metadata for WordPress update checks.

This worker supports multiple plugins (public and private) using a routing map stored in Cloudflare KV.

## Status checklist

- [x] Worker supports slug-based multi-plugin routing.
- [x] Routing is loaded dynamically from Cloudflare KV key `routes`.
- [x] Private/public plugin handling is supported via `tokenKey` and `isPrivate`.
- [x] Download URLs are rewritten to Worker-managed `/download/...` routes.
- [x] Edge caching is enabled for manifests and download redirects.
- [x] Optional cache bypass is implemented.
- [x] Optional token-protected bypass is implemented.
- [x] GitHub Actions deploy workflow is included (`.github/workflows/deploy.yml`).
- [x] Repository config kept clean (no KV IDs or secrets committed).
- [ ] Create the KV namespace and add the `routes` JSON.
- [ ] Add required Cloudflare/GitHub secrets.
- [ ] Run `npx wrangler deploy` for first deployment.

## Project structure

- `src/index.js`: Worker entrypoint and proxy logic.
- `wrangler.toml`: Worker configuration.
- `.github/workflows/deploy.yml`: Automatic deploy on push to `main`.

## 1) Install dependencies

```bash
npm install
```

## Recommended: interactive setup script

Use the hardened setup script to run pre-flight checks and safely configure a new plugin route without manually editing live KV JSON.

```bash
chmod +x setup.sh
./setup.sh
```

The script will:

- Verify local prerequisites (`npx`, Wrangler, `jq`) and Cloudflare authentication.
- Confirm Worker context and deployment visibility.
- Let you pick a worker-specific KV namespace title (default: `<worker-name>_CONFIG_KV`).
- Use `CONFIG_KV` as the Worker binding name while keeping the namespace title unique in Cloudflare.
- Read/write the `routes` key using **remote** KV operations (Cloudflare account state, not local preview state).
- Provide a prompt-based menu to review routes, inspect slug config, and register/update repo mappings.
- Optionally register/update GitHub PAT secrets for private repos.
- Optionally deploy/update the live Worker in Cloudflare using a temporary runtime config (without committing account IDs).

Important input rule:

- `owner` should be org/user only (example: `webmultipliers`).
- `repo` should be repository name only (example: `plugin-for-wordpress`), not `owner/repo`.

## 2) Authenticate Wrangler

```bash
npx wrangler login
```

This opens a browser and links Wrangler to your Cloudflare account.

## 3) Create and bind KV namespace

Create a Cloudflare KV namespace (for example `WP_UPDATES_CONFIG`) and bind it to this Worker as `CONFIG_KV`.

Bind it outside this repository (Cloudflare Dashboard or Wrangler command line) so no account-specific IDs are committed.

If you use `./setup.sh`, this is handled interactively for each run and can deploy with runtime binding via temporary config.

## 4) Add routing map to KV

Create a KV key named `routes` with JSON content like:

```json
{
  "my-private-plugin": {
    "owner": "your-org",
    "repo": "private-plugin-repo",
    "tokenKey": "GITHUB_PAT_MY_PRIVATE_PLUGIN",
    "isPrivate": true
  },
  "my-public-plugin": {
    "owner": "your-org",
    "repo": "public-plugin-repo",
    "tokenKey": null,
    "isPrivate": false
  }
}
```

You can manage this from the Cloudflare dashboard without changing repository code.

Note for Wrangler v4 CLI usage outside the setup script: use `--remote` for KV key operations when you intend to read/write Cloudflare account KV.

## 5) Store secrets securely

For each private plugin, store a matching Worker secret in Cloudflare.

Example for the `tokenKey` above:

```bash
npx wrangler secret put GITHUB_PAT_MY_PRIVATE_PLUGIN
```

Public plugins can use `tokenKey: null` with `isPrivate: false`.

## 6) Deploy from terminal

```bash
npx wrangler deploy
```

Wrangler outputs your Worker URL, for example:

`https://cf-wp-updates-proxy.<your-subdomain>.workers.dev`

## 7) Query the proxy

Service status endpoints:

```text
GET /
GET /status
GET /status.json
GET /<slug>/status.json
```

- `/` and `/status` return an HTML status page with route health and delivery details.
- `/status.json` returns a machine-readable service report.
- `/<slug>/status.json` returns a machine-readable report for one plugin route.
- Add `?check=0` to use preflight-only checks (no GitHub API calls).

Manifest endpoint:

```text
GET /<slug>/updates.json
```

Download endpoint (generated in manifest automatically):

```text
GET /<slug>/download/<tag>/<filename>
```

Example:

```text
https://cf-wp-updates-proxy.<your-subdomain>.workers.dev/my-private-plugin/updates.json
```

## 8) Cache behavior

This Worker uses Cloudflare Cache API to reduce GitHub API traffic:

- `/<slug>/updates.json` responses are cached at the edge.
- `/<slug>/download/<tag>/<filename>` redirect responses are cached at the edge.

Optional environment variables (set as Worker vars) control TTL:

- `MANIFEST_CACHE_TTL_SECONDS` (default: `21600`, 6 hours)
- `DOWNLOAD_REDIRECT_CACHE_TTL_SECONDS` (default: `900`, 15 minutes)

Optional cache bypass for testing:

- `ALLOW_CACHE_BYPASS` (default: `false`)
- When set to `true`, add `?refresh=1` (or `?no_cache=1`) to bypass cache for that request.
- `CACHE_BYPASS_TOKEN` (optional): if set, bypass requests must include header `x-cache-bypass-token` with this exact value.

Example bypass request with token:

```bash
curl -H "x-cache-bypass-token: <your-token>" \
  "https://cf-wp-updates-proxy.<your-subdomain>.workers.dev/my-private-plugin/updates.json?refresh=1"
```

## GitHub Actions deployment

The workflow in `.github/workflows/deploy.yml` deploys on pushes to `main`.

Add these repository secrets in GitHub:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

The workflow uses `cloudflare/wrangler-action@v3` to deploy.

## Notes

- Keep all GitHub PAT values out of source files and `wrangler.toml`.
- Use one secret per private plugin (`tokenKey` in the KV `routes` JSON), stored with `wrangler secret put`.
- Plugin additions/changes are data updates in KV, not code changes.
- The Worker only accepts `GET` requests.