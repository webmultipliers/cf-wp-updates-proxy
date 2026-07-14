# cf-wp-updates-proxy

Cloudflare Worker that proxies GitHub release metadata for WordPress update checks.

This worker supports multiple plugins (public and private) using a routing map stored in Cloudflare KV.

## Project structure

- `src/index.js`: Worker entrypoint and proxy logic.
- `wrangler.toml`: Worker configuration.
- `.github/workflows/deploy.yml`: Automatic deploy on push to `main`.

## 1) Install dependencies

```bash
npm install
```

## Recommended: operational CLI

Use the command-driven CLI for repeatable remote operations against Cloudflare.

```bash
npm run cli -- --help
```

Primary commands:

```bash
# One-time bootstrap: ensure namespace, initialize routes key, deploy safely
npm run bootstrap

# Health/config check
npm run doctor

# Deploy while preserving vars and CONFIG_KV binding
npm run cli -- worker deploy --create-namespace

# Update a private plugin route (fails if token secret missing by default)
npm run cli -- routes upsert fouanalytics webmultipliers fouanalytics-for-wordpress --private

# Add or rotate a worker secret
npm run cli -- secrets put GITHUB_PAT_FOUANALYTICS

# List and inspect routes
npm run cli -- routes list
npm run cli -- routes get fouanalytics
```

The CLI script is in `bin/proxy-cli.sh` and supports:

- `worker doctor` (alias `worker check`): validates auth, namespace resolution, and routes JSON integrity.
- `worker bootstrap` (alias `worker init`): creates/resolves namespace, initializes `routes`, deploys with runtime binding.
- `worker deploy` (alias `worker apply`): deploys with `--keep-vars` and injects CONFIG_KV binding when needed.
- `routes list|get|upsert` (aliases `ls|show|set`): manages route mappings in remote KV.
- `secrets put` (alias `secrets set`): updates Worker secrets on the correct Worker name.

`setup.sh` is now only a launcher to `bin/proxy-cli.sh` (no interactive legacy wizard).

## 2) Authenticate Wrangler

```bash
npx wrangler login
```

This opens a browser and links Wrangler to your Cloudflare account.

## 3) Create and bind KV namespace

Create a Cloudflare KV namespace (for example `WP_UPDATES_CONFIG`) and bind it to this Worker as `CONFIG_KV`.

Bind it outside this repository (Cloudflare Dashboard or Wrangler command line) so no account-specific IDs are committed.

If you use `./setup.sh worker bootstrap --create-namespace`, this is handled as a command-driven flow and can deploy with runtime binding via temporary config.

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

Note for Wrangler v4 CLI usage outside this CLI: use `--remote` for KV key operations when you intend to read/write Cloudflare account KV.

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
- `CONFIG_KV_NAMESPACE_ID` (Cloudflare KV namespace id bound as `CONFIG_KV`)

The workflow uses `cloudflare/wrangler-action@v3` to deploy.
It generates a temporary `.wrangler-ci.toml` at runtime so deploys include the KV binding and do not wipe bindings.

## Notes

- Keep all GitHub PAT values out of source files and `wrangler.toml`.
- Use one secret per private plugin (`tokenKey` in the KV `routes` JSON), stored with `wrangler secret put`.
- Plugin additions/changes are data updates in KV, not code changes.
- The Worker only accepts `GET` requests.