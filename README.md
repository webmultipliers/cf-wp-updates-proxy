# cf-wp-updates-proxy

Cloudflare Worker that proxies GitHub release metadata for WordPress update checks.

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

## 3) Store secrets securely

Set your GitHub PAT in Cloudflare as a Worker secret:

```bash
npx wrangler secret put GITHUB_PAT
```

Paste your token when prompted.

## 4) Deploy from terminal

```bash
npx wrangler deploy
```

Wrangler outputs your Worker URL, for example:

`https://cf-wp-updates-proxy.<your-subdomain>.workers.dev`

## 5) Query the proxy

Use `owner` and `repo` query params:

```text
GET /?owner=<github-owner>&repo=<github-repo>
```

Example:

```text
https://cf-wp-updates-proxy.<your-subdomain>.workers.dev/?owner=webmultipliers&repo=cf-wp-updates-proxy
```

## GitHub Actions deployment

The workflow in `.github/workflows/deploy.yml` deploys on pushes to `main`.

Add these repository secrets in GitHub:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

The workflow uses `cloudflare/wrangler-action@v3` to deploy.

## Notes

- Keep `GITHUB_PAT` out of source files and `wrangler.toml`.
- `GITHUB_PAT` is a Worker secret stored in Cloudflare (set with `wrangler secret put`), not a GitHub repository secret.
- The Worker only accepts `GET` requests.