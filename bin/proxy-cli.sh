#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WRANGLER_FILE="${ROOT_DIR}/wrangler.toml"

NAMESPACE_ID_OPT=""
NAMESPACE_TITLE_OPT=""
WORKER_NAME_OPT=""
WORKER_URL_OPT=""
CREATE_NAMESPACE="false"
ALLOW_MISSING_SECRET="false"

info() {
  echo "[info] $*"
}

warn() {
  echo "[warn] $*" >&2
}

fail() {
  echo "[error] $*" >&2
  exit 1
}

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf "%s" "$s"
}

require_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || fail "missing required command: $cmd"
}

extract_toml_string() {
  local key="$1"
  awk -v key="$key" '
    $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
      line = $0
      sub(/^[^=]*=[[:space:]]*/, "", line)
      gsub(/^["\x27 ]+|["\x27 ]+$/, "", line)
      print line
      exit
    }
  ' "$WRANGLER_FILE"
}

extract_config_kv_namespace_id() {
  awk '
    BEGIN { in_kv = 0; in_config = 0 }
    /^\[\[kv_namespaces\]\]/ { in_kv = 1; in_config = 0; next }
    /^\[/ && $0 !~ /^\[\[kv_namespaces\]\]/ { in_kv = 0; in_config = 0 }
    in_kv && /binding[[:space:]]*=/ {
      line = $0
      sub(/^[^=]*=[[:space:]]*/, "", line)
      gsub(/^["\x27 ]+|["\x27 ]+$/, "", line)
      in_config = (line == "CONFIG_KV")
      next
    }
    in_kv && in_config && /id[[:space:]]*=/ {
      line = $0
      sub(/^[^=]*=[[:space:]]*/, "", line)
      gsub(/^["\x27 ]+|["\x27 ]+$/, "", line)
      print line
      exit
    }
  ' "$WRANGLER_FILE"
}

resolve_worker_name() {
  if [[ -n "$WORKER_NAME_OPT" ]]; then
    printf "%s" "$WORKER_NAME_OPT"
    return
  fi

  local worker_name
  worker_name="$(extract_toml_string "name")"
  [[ -n "$worker_name" ]] || fail "could not read worker name from wrangler.toml"
  printf "%s" "$worker_name"
}

get_namespace_id_by_title() {
  local title="$1"
  local ns_list
  ns_list="$(npx --yes wrangler kv namespace list 2>/dev/null || true)"

  if echo "$ns_list" | jq -e 'type == "array"' >/dev/null 2>&1; then
    echo "$ns_list" | jq -r --arg title "$title" '.[] | select(.title == $title) | .id' | head -n1
    return
  fi

  echo "$ns_list" | grep -F "$title" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1
}

create_namespace_by_title() {
  local title="$1"
  local output
  output="$(npx --yes wrangler kv namespace create "$title" 2>&1 || true)"

  local id
  id="$(echo "$output" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
  if [[ -z "$id" ]]; then
    id="$(get_namespace_id_by_title "$title")"
  fi

  [[ -n "$id" ]] || fail "failed to create or resolve namespace for title: $title"
  printf "%s" "$id"
}

resolve_namespace_id() {
  local create_if_missing="$1"

  if [[ -n "$NAMESPACE_ID_OPT" ]]; then
    printf "%s" "$NAMESPACE_ID_OPT"
    return
  fi

  local wrangler_bound_id
  wrangler_bound_id="$(extract_config_kv_namespace_id || true)"
  if [[ -n "$wrangler_bound_id" ]]; then
    printf "%s" "$wrangler_bound_id"
    return
  fi

  local worker_name
  worker_name="$(resolve_worker_name)"
  local title="${NAMESPACE_TITLE_OPT:-${worker_name}_CONFIG_KV}"

  local existing
  existing="$(get_namespace_id_by_title "$title")"
  if [[ -n "$existing" ]]; then
    printf "%s" "$existing"
    return
  fi

  if [[ "$create_if_missing" == "true" ]]; then
    local created
    created="$(create_namespace_by_title "$title")"
    printf "%s" "$created"
    return
  fi

  fail "no CONFIG_KV namespace id found; pass --namespace-id, --namespace-title, or use --create-namespace"
}

deploy_with_runtime_binding() {
  local namespace_id="$1"
  local tmp_config=""
  local config_has_binding

  config_has_binding="$(extract_config_kv_namespace_id || true)"

  if [[ -n "$config_has_binding" ]]; then
    info "deploying with existing CONFIG_KV binding from wrangler.toml"
    npx --yes wrangler deploy --keep-vars
    return
  fi

  tmp_config="$(mktemp "${ROOT_DIR}/.wrangler-runtime-XXXXXX.toml")"
  cp "$WRANGLER_FILE" "$tmp_config"
  printf '\n[[kv_namespaces]]\nbinding = "CONFIG_KV"\nid = "%s"\n' "$namespace_id" >> "$tmp_config"

  info "deploying with temporary config + CONFIG_KV binding"
  npx --yes wrangler deploy --config "$tmp_config" --keep-vars
  rm -f "$tmp_config"
}

load_routes_json() {
  local namespace_id="$1"
  local raw
  raw="$(npx --yes wrangler kv key get routes --namespace-id "$namespace_id" --remote 2>/dev/null || true)"
  raw="$(trim "$raw")"

  if [[ -z "$raw" || "$raw" == "null" || "$raw" == "Value not found" ]]; then
    raw='{}'
  fi

  echo "$raw" | jq -e 'type == "object"' >/dev/null 2>&1 || fail "KV key routes is not a valid JSON object"
  printf "%s" "$raw"
}

save_routes_json() {
  local namespace_id="$1"
  local routes_json="$2"
  local compact

  compact="$(echo "$routes_json" | jq -c '.')"
  npx --yes wrangler kv key put routes "$compact" --namespace-id "$namespace_id" --remote >/dev/null
}

secret_exists_for_worker() {
  local worker_name="$1"
  local key="$2"

  npx --yes wrangler secret list --name "$worker_name" 2>/dev/null | jq -e --arg key "$key" '.[] | select(.name == $key)' >/dev/null
}

cmd_doctor() {
  require_cmd npx
  require_cmd jq
  require_cmd curl

  [[ -f "$WRANGLER_FILE" ]] || fail "wrangler.toml not found"

  local worker_name
  worker_name="$(resolve_worker_name)"

  local status=0
  info "worker: ${worker_name}"

  if npx --yes wrangler whoami >/dev/null 2>&1; then
    info "wrangler auth: ok"
  else
    warn "wrangler auth: not authenticated"
    status=1
  fi

  local namespace_id=""
  if namespace_id="$(resolve_namespace_id "false" 2>/dev/null)"; then
    info "CONFIG_KV namespace id: ${namespace_id}"

    local routes
    if routes="$(load_routes_json "$namespace_id" 2>/dev/null)"; then
      info "routes key: valid JSON object ($(echo "$routes" | jq 'length') slug entries)"
    else
      warn "routes key: missing or invalid"
      status=1
    fi
  else
    warn "CONFIG_KV namespace id unresolved"
    status=1
  fi

  if [[ -n "$WORKER_URL_OPT" ]]; then
    local code
    code="$(curl -sS -o /dev/null -w "%{http_code}" "$WORKER_URL_OPT/status.json" || true)"
    if [[ "$code" == "200" || "$code" == "503" ]]; then
      info "status endpoint reachable: ${WORKER_URL_OPT}/status.json (HTTP ${code})"
    else
      warn "status endpoint check failed: HTTP ${code}"
      status=1
    fi
  fi

  if [[ "$status" -ne 0 ]]; then
    fail "doctor check failed"
  fi

  info "doctor check passed"
}

cmd_bootstrap() {
  require_cmd npx
  require_cmd jq

  local namespace_id
  namespace_id="$(resolve_namespace_id "true")"
  info "using CONFIG_KV namespace id: ${namespace_id}"

  local routes
  routes="$(npx --yes wrangler kv key get routes --namespace-id "$namespace_id" --remote 2>/dev/null || true)"
  routes="$(trim "$routes")"
  if [[ -z "$routes" || "$routes" == "null" || "$routes" == "Value not found" ]]; then
    info "initializing routes key as {}"
    npx --yes wrangler kv key put routes '{}' --namespace-id "$namespace_id" --remote >/dev/null
  else
    echo "$routes" | jq -e 'type == "object"' >/dev/null 2>&1 || fail "existing routes key is not a JSON object"
  fi

  deploy_with_runtime_binding "$namespace_id"

  info "bootstrap complete"
  info "set GitHub Actions secret CONFIG_KV_NAMESPACE_ID=${namespace_id}"
}

cmd_deploy() {
  require_cmd npx
  local create="false"
  if [[ "$CREATE_NAMESPACE" == "true" ]]; then
    create="true"
  fi

  local namespace_id
  namespace_id="$(resolve_namespace_id "$create")"
  info "deploy target CONFIG_KV namespace id: ${namespace_id}"

  deploy_with_runtime_binding "$namespace_id"
  info "deploy complete"
}

cmd_routes_list() {
  local namespace_id
  namespace_id="$(resolve_namespace_id "false")"
  local routes
  routes="$(load_routes_json "$namespace_id")"

  if [[ "$(echo "$routes" | jq 'length')" -eq 0 ]]; then
    echo "(no routes)"
    return
  fi

  echo "$routes" | jq -r 'keys[]'
}

cmd_routes_get() {
  local slug="$1"
  local namespace_id
  namespace_id="$(resolve_namespace_id "false")"
  local routes
  routes="$(load_routes_json "$namespace_id")"

  echo "$routes" | jq --arg slug "$slug" '.[$slug] // empty'
}

normalize_slug() {
  local slug="$1"
  [[ "$slug" =~ ^[a-z0-9._-]+$ ]] || fail "invalid slug format: $slug"
  printf "%s" "$slug"
}

cmd_routes_upsert() {
  local slug="$1"
  local owner="$2"
  local repo="$3"
  local private_mode="$4"
  local token_key_arg="$5"

  slug="$(normalize_slug "$slug")"
  owner="$(trim "$owner")"
  repo="$(trim "$repo")"

  [[ -n "$owner" && -n "$repo" ]] || fail "owner and repo are required"
  if [[ "$repo" == */* ]]; then
    fail "repo must be repository name only (not owner/repo)"
  fi

  local namespace_id
  namespace_id="$(resolve_namespace_id "false")"
  local routes
  routes="$(load_routes_json "$namespace_id")"

  local token_key="null"
  if [[ "$private_mode" == "true" ]]; then
    if [[ -n "$token_key_arg" ]]; then
      token_key="$token_key_arg"
    else
      token_key="GITHUB_PAT_${slug^^}"
      token_key="$(echo "$token_key" | tr '-' '_' | tr '.' '_')"
    fi

    local worker_name
    worker_name="$(resolve_worker_name)"
    if ! secret_exists_for_worker "$worker_name" "$token_key"; then
      if [[ "$ALLOW_MISSING_SECRET" == "true" ]]; then
        warn "secret ${token_key} is missing on worker ${worker_name}; route will still be saved"
      else
        fail "secret ${token_key} missing on worker ${worker_name}; run secret put first or pass --allow-missing-secret"
      fi
    fi

    routes="$(echo "$routes" | jq --arg slug "$slug" --arg owner "$owner" --arg repo "$repo" --arg tokenKey "$token_key" '.[$slug] = {owner: $owner, repo: $repo, tokenKey: $tokenKey, isPrivate: true}')"
  else
    routes="$(echo "$routes" | jq --arg slug "$slug" --arg owner "$owner" --arg repo "$repo" '.[$slug] = {owner: $owner, repo: $repo, tokenKey: null, isPrivate: false}')"
  fi

  save_routes_json "$namespace_id" "$routes"
  info "route saved for slug ${slug}"
  echo "$routes" | jq --arg slug "$slug" '.[$slug]'
}

cmd_secret_put() {
  local key="$1"
  local value="${2:-}"
  local worker_name

  [[ -n "$key" ]] || fail "secret key is required"
  worker_name="$(resolve_worker_name)"

  if [[ -z "$value" ]]; then
    if [[ -t 0 ]]; then
      read -r -s -p "Secret value for ${key}: " value
      echo
    else
      value="$(cat)"
      value="$(trim "$value")"
    fi
  fi

  [[ -n "$value" ]] || fail "secret value cannot be empty"

  printf "%s" "$value" | npx --yes wrangler secret put "$key" --name "$worker_name" >/dev/null
  info "secret updated on worker ${worker_name}: ${key}"
}

usage() {
  cat <<'USAGE'
Usage:
  bin/proxy-cli.sh [global-options] <namespace> <command> [args]

Global options:
  --namespace-id <id>         Use this CONFIG_KV namespace id
  --namespace-title <title>   Resolve namespace id by title
  --worker-name <name>        Override worker name from wrangler.toml
  --worker-url <url>          URL for health checks in doctor
  --create-namespace          Allow create when namespace does not exist
  --allow-missing-secret      Allow private route save even when token secret is missing

Namespaces:
  worker (alias: w)
    doctor (alias: check)
      Validate auth, namespace resolution, and routes JSON integrity.

    bootstrap (alias: init)
      Ensure namespace exists, initialize routes key, and deploy with CONFIG_KV binding.

    deploy (alias: apply)
      Deploy worker and preserve vars; inject CONFIG_KV binding at deploy time if needed.

  routes (alias: r)
    list (alias: ls)
    get <slug> (alias: show)
    upsert <slug> <owner> <repo> [--private] [--token-key <key>] (alias: set)

  secrets (alias: s)
    put <KEY> [VALUE] (alias: set)
    If VALUE is omitted, reads from hidden prompt or stdin.

Examples:
  bin/proxy-cli.sh worker bootstrap --create-namespace
  bin/proxy-cli.sh worker doctor --worker-url https://cf-wp-updates-proxy.example.workers.dev
  bin/proxy-cli.sh routes upsert fouanalytics webmultipliers fouanalytics-for-wordpress --private
  bin/proxy-cli.sh secrets put GITHUB_PAT_FOUANALYTICS
USAGE
}

parse_global_options() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --namespace-id)
        NAMESPACE_ID_OPT="${2:-}"
        shift 2
        ;;
      --namespace-title)
        NAMESPACE_TITLE_OPT="${2:-}"
        shift 2
        ;;
      --worker-name)
        WORKER_NAME_OPT="${2:-}"
        shift 2
        ;;
      --worker-url)
        WORKER_URL_OPT="${2:-}"
        shift 2
        ;;
      --create-namespace)
        CREATE_NAMESPACE="true"
        shift
        ;;
      --allow-missing-secret)
        ALLOW_MISSING_SECRET="true"
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        break
        ;;
    esac
  done

  MAIN_ARGS=("$@")
}

main() {
  cd "$ROOT_DIR"
  parse_global_options "$@"
  set -- "${MAIN_ARGS[@]}"

  [[ $# -gt 0 ]] || {
    usage
    exit 1
  }

  local namespace="$1"
  shift

  case "$namespace" in
    worker|w)
      local sub="${1:-}"
      shift || true
      case "$sub" in
        doctor|check)
          cmd_doctor
          ;;
        bootstrap|init)
          cmd_bootstrap
          ;;
        deploy|apply)
          cmd_deploy
          ;;
        *)
          fail "unknown worker command: ${sub:-<empty>}"
          ;;
      esac
      ;;
    routes|r)
      local sub="${1:-}"
      shift || true
      case "$sub" in
        list|ls)
          cmd_routes_list
          ;;
        get|show)
          [[ $# -ge 1 ]] || fail "routes get requires <slug>"
          cmd_routes_get "$1"
          ;;
        upsert|set)
          [[ $# -ge 3 ]] || fail "routes upsert requires <slug> <owner> <repo>"
          local slug="$1"
          local owner="$2"
          local repo="$3"
          shift 3

          local private_mode="false"
          local token_key=""
          while [[ $# -gt 0 ]]; do
            case "$1" in
              --private)
                private_mode="true"
                shift
                ;;
              --token-key)
                token_key="${2:-}"
                shift 2
                ;;
              *)
                fail "unknown routes upsert option: $1"
                ;;
            esac
          done

          cmd_routes_upsert "$slug" "$owner" "$repo" "$private_mode" "$token_key"
          ;;
        *)
          fail "unknown routes subcommand: ${sub:-<empty>}"
          ;;
      esac
      ;;
    secrets|s)
      local sub="${1:-}"
      shift || true
      case "$sub" in
        put|set)
          [[ $# -ge 1 ]] || fail "secret put requires <KEY> [VALUE]"
          cmd_secret_put "$1" "${2:-}"
          ;;
        *)
          fail "unknown secrets command: ${sub:-<empty>}"
          ;;
      esac
      ;;
    help)
      usage
      ;;
    *)
      fail "unknown namespace: $namespace"
      ;;
  esac
}

main "$@"
