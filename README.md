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

## 2) Authenticate Wrangler

```bash
npx wrangler login
```

This opens a browser and links Wrangler to your Cloudflare account.

## 3) Create and bind KV namespace

Create a Cloudflare KV namespace (for example `WP_UPDATES_CONFIG`) and bind it to this Worker as `CONFIG_KV`.

In `wrangler.toml`, set your real namespace ID:

```toml
[[kv_namespaces]]
binding = "CONFIG_KV"
id = "YOUR_KV_NAMESPACE_ID"
preview_id = "YOUR_KV_NAMESPACE_ID"
```

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