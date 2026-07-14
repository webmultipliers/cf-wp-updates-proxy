#!/usr/bin/env bash

set -euo pipefail

BOLD="\033[1m"
GREEN="\033[0;32m"
YELLOW="\033[0;33m"
CYAN="\033[0;36m"
RED="\033[0;31m"
RESET="\033[0m"

print_header() {
  echo "--------------------------------------------------------"
  echo -e "${BOLD}$1${RESET}"
}

require_cmd() {
  local cmd="$1"
  local hint="$2"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo -e "${RED}ERROR:${RESET} Missing command: $cmd"
    echo "$hint"
    exit 1
  fi
}

ask_yes_no() {
  local prompt="$1"
  local answer
  while true; do
    read -r -p "$prompt [y/N]: " answer
    answer="${answer,,}"
    if [[ -z "$answer" || "$answer" == "n" || "$answer" == "no" ]]; then
      return 1
    fi
    if [[ "$answer" == "y" || "$answer" == "yes" ]]; then
      return 0
    fi
    echo "Please answer y or n."
  done
}

trim() {
  xargs <<<"$1"
}

TMP_DEPLOY_CONFIG=""

cleanup() {
  if [[ -n "$TMP_DEPLOY_CONFIG" && -f "$TMP_DEPLOY_CONFIG" ]]; then
    rm -f "$TMP_DEPLOY_CONFIG"
  fi
}

trap cleanup EXIT

extract_toml_string() {
  local key="$1"
  awk -v key="$key" '
    $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
      line = $0
      sub(/^[^=]*=[[:space:]]*/, "", line)
      gsub(/^["'\'' ]+|["'\'' ]+$/, "", line)
      print line
      exit
    }
  ' wrangler.toml
}

extract_config_kv_namespace_id() {
  awk '
    BEGIN { in_kv = 0; in_config = 0 }
    /^\[\[kv_namespaces\]\]/ { in_kv = 1; in_config = 0; next }
    /^\[/ && $0 !~ /^\[\[kv_namespaces\]\]/ { in_kv = 0; in_config = 0 }
    in_kv && /binding[[:space:]]*=/ {
      line = $0
      sub(/^[^=]*=[[:space:]]*/, "", line)
      gsub(/^["'\'' ]+|["'\'' ]+$/, "", line)
      in_config = (line == "CONFIG_KV")
      next
    }
    in_kv && in_config && /id[[:space:]]*=/ {
      line = $0
      sub(/^[^=]*=[[:space:]]*/, "", line)
      gsub(/^["'\'' ]+|["'\'' ]+$/, "", line)
      print line
      exit
    }
  ' wrangler.toml
}

deploy_worker_with_runtime_binding() {
  local namespace_id="$1"
  local config_has_binding

  config_has_binding="$(extract_config_kv_namespace_id || true)"
  TMP_DEPLOY_CONFIG=""

  if [[ -n "$config_has_binding" ]]; then
    echo "Deploying using existing repo config binding..."
    npx --yes wrangler deploy --keep-vars
    return
  fi

  TMP_DEPLOY_CONFIG="$(mktemp "${PWD}/.wrangler-runtime-XXXXXX.toml")"
  cp wrangler.toml "$TMP_DEPLOY_CONFIG"
  cat >> "$TMP_DEPLOY_CONFIG" <<EOF

[[kv_namespaces]]
binding = "CONFIG_KV"
id = "$namespace_id"
EOF

  echo "Deploying with temporary runtime config (not committed)..."
  npx --yes wrangler deploy --config "$TMP_DEPLOY_CONFIG" --keep-vars
}

get_namespace_id_by_title() {
  local title="$1"
  local ns_list
  ns_list="$(npx --yes wrangler kv namespace list 2>/dev/null || true)"

  # Wrangler v4 prints JSON by default for this command.
  if echo "$ns_list" | jq -e 'type == "array"' >/dev/null 2>&1; then
    echo "$ns_list" | jq -r --arg title "$title" '.[] | select(.title == $title) | .id' | head -n1
    return
  fi

  # Fallback for non-JSON output formats.
  echo "$ns_list" | grep -i "$title" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1
}

echo -e "${BOLD}${CYAN}Cloudflare Worker Setup Wizard${RESET}"
echo "This script guides: worker URL check -> bindings check -> missing KV fix -> prompt-based KV review/register."

print_header "1) Environment and Cloudflare Auth"

require_cmd "npx" "Install Node.js/npm first."
require_cmd "jq" "Install jq first, then rerun."
require_cmd "curl" "Install curl first, then rerun."

if ! npx --yes wrangler --version >/dev/null 2>&1; then
  echo -e "${RED}ERROR:${RESET} Wrangler not available. Run npm install first."
  exit 1
fi

if npx --yes wrangler whoami >/dev/null 2>&1; then
  echo -e "${GREEN}OK:${RESET} Authenticated with Cloudflare."
else
  echo -e "${YELLOW}Not logged in. Opening Wrangler login...${RESET}"
  npx --yes wrangler login
fi

if [[ ! -f "wrangler.toml" ]]; then
  echo -e "${RED}ERROR:${RESET} wrangler.toml not found in current directory."
  exit 1
fi

WORKER_NAME="$(extract_toml_string "name")"
if [[ -z "$WORKER_NAME" ]]; then
  echo -e "${RED}ERROR:${RESET} Could not read worker name from wrangler.toml."
  exit 1
fi
echo -e "${GREEN}OK:${RESET} Worker name: ${BOLD}$WORKER_NAME${RESET}"

DEFAULT_NAMESPACE_TITLE="${WORKER_NAME}_CONFIG_KV"

print_header "2) What's your Worker ID/URL?"

read -r -p "Worker URL (or ID note) (example: https://my-worker.my-subdomain.workers.dev). Leave blank to skip: " WORKER_URL
WORKER_URL="$(trim "$WORKER_URL")"

if [[ -n "$WORKER_URL" ]]; then
  HTTP_CODE="$(curl -sS -o /dev/null -w "%{http_code}" "$WORKER_URL" 2>/dev/null || true)"
  if [[ -z "$HTTP_CODE" ]]; then
    HTTP_CODE="000"
  fi
  if [[ "$HTTP_CODE" == "000" ]]; then
    echo -e "${YELLOW}WARN:${RESET} Could not reach that URL right now."
  else
    echo -e "${GREEN}OK:${RESET} Worker URL responded with HTTP $HTTP_CODE"
  fi
else
  echo "Skipped Worker URL check."
fi

print_header "3) Checking bindings"

NAMESPACE_ID="$(extract_config_kv_namespace_id)"
if [[ -n "$NAMESPACE_ID" ]]; then
  echo -e "${GREEN}OK:${RESET} CONFIG_KV binding found with id: ${CYAN}$NAMESPACE_ID${RESET}"
else
  echo -e "${YELLOW}Missing KV setup:${RESET} CONFIG_KV is not bound in wrangler.toml"
  echo "Note: CONFIG_KV is the Worker binding name."
  echo "The Cloudflare KV namespace title can be unique per worker."
  echo "No repository files will be modified. We will use a namespace id only for this setup session."

  read -r -p "KV namespace title to use/create [${DEFAULT_NAMESPACE_TITLE}]: " NAMESPACE_TITLE
  NAMESPACE_TITLE="$(trim "$NAMESPACE_TITLE")"
  if [[ -z "$NAMESPACE_TITLE" ]]; then
    NAMESPACE_TITLE="$DEFAULT_NAMESPACE_TITLE"
  fi

  EXISTING_ID="$(get_namespace_id_by_title "$NAMESPACE_TITLE" || true)"

  # Backward-compatible fallback for older setups.
  if [[ -z "$EXISTING_ID" && "$NAMESPACE_TITLE" != "CONFIG_KV" ]]; then
    LEGACY_ID="$(get_namespace_id_by_title "CONFIG_KV" || true)"
    if [[ -n "$LEGACY_ID" ]]; then
      echo -e "${YELLOW}Found legacy namespace title CONFIG_KV:${RESET} $LEGACY_ID"
      if ask_yes_no "Use legacy CONFIG_KV namespace for this run?"; then
        EXISTING_ID="$LEGACY_ID"
      fi
    fi
  fi

  if [[ -n "$EXISTING_ID" ]]; then
    echo "Found existing namespace '$NAMESPACE_TITLE' with id: $EXISTING_ID"
    if ask_yes_no "Use this namespace id for this setup run?"; then
      NAMESPACE_ID="$EXISTING_ID"
    fi
  fi

  if [[ -z "$NAMESPACE_ID" ]]; then
    if ask_yes_no "Create namespace '$NAMESPACE_TITLE' now?"; then
      CREATE_OUTPUT="$(npx --yes wrangler kv namespace create "$NAMESPACE_TITLE" 2>&1 || true)"
      NAMESPACE_ID="$(echo "$CREATE_OUTPUT" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"

      # If create output did not include an id (or namespace already existed), resolve by listing.
      if [[ -z "$NAMESPACE_ID" ]]; then
        NAMESPACE_ID="$(get_namespace_id_by_title "$NAMESPACE_TITLE" || true)"
      fi

      if [[ -z "$NAMESPACE_ID" ]]; then
        echo -e "${RED}ERROR:${RESET} Could not resolve namespace id after create attempt."
        echo "Create output was:"
        echo "$CREATE_OUTPUT"
        echo "Run manually: npx wrangler kv namespace list"
        exit 1
      fi

      echo -e "${GREEN}OK:${RESET} Using namespace id: $NAMESPACE_ID"
    fi
  fi

  if [[ -z "$NAMESPACE_ID" ]]; then
    read -r -p "Paste existing KV namespace id to use for this run (or leave blank to cancel): " NAMESPACE_ID
    NAMESPACE_ID="$(trim "$NAMESPACE_ID")"
  fi

  if [[ -z "$NAMESPACE_ID" ]]; then
    echo "Cannot continue without a namespace id. Exiting."
    exit 1
  fi

  echo -e "${GREEN}OK:${RESET} Using namespace id for this run: ${CYAN}$NAMESPACE_ID${RESET}"
fi

if ask_yes_no "Update the live Worker in Cloudflare now with CONFIG_KV=$NAMESPACE_ID?"; then
  deploy_worker_with_runtime_binding "$NAMESPACE_ID"
  echo -e "${GREEN}OK:${RESET} Worker updated on Cloudflare."
fi

load_routes() {
  local raw
  raw="$(npx --yes wrangler kv key get "routes" --namespace-id "$NAMESPACE_ID" --remote 2>/dev/null || true)"
  raw="$(trim "$raw")"

  if [[ -z "$raw" || "$raw" == "null" || "$raw" == "Value not found" ]]; then
    raw='{}'
  fi

  if ! echo "$raw" | jq -e 'type == "object"' >/dev/null 2>&1; then
    echo -e "${YELLOW}WARN:${RESET} KV key 'routes' is not a valid JSON object."
    echo "Current raw value:"
    echo "$raw"
    if ask_yes_no "Initialize routes to an empty JSON object {} now?"; then
      raw='{}'
      ROUTES_JSON="$raw"
      save_routes
      echo -e "${GREEN}OK:${RESET} routes initialized to {}"
    else
      echo "Cannot continue KV menu without a valid JSON object in routes."
      exit 1
    fi
  fi

  ROUTES_JSON="$raw"
}

save_routes() {
  local compact
  compact="$(echo "$ROUTES_JSON" | jq -c '.')"
  npx --yes wrangler kv key put "routes" "$compact" --namespace-id "$NAMESPACE_ID" --remote >/dev/null
}

show_routes_summary() {
  echo "Current route slugs:"
  if [[ "$(echo "$ROUTES_JSON" | jq 'length')" -eq 0 ]]; then
    echo "  (none)"
    return
  fi
  echo "$ROUTES_JSON" | jq -r 'keys[]' | sed 's/^/  - /'
}

review_slug() {
  local slug
  read -r -p "Enter slug to review: " slug
  slug="$(trim "$slug")"
  if [[ -z "$slug" ]]; then
    echo "No slug entered."
    return
  fi
  if ! echo "$ROUTES_JSON" | jq -e --arg slug "$slug" 'has($slug)' >/dev/null; then
    echo -e "${YELLOW}Not found:${RESET} $slug"
    return
  fi
  echo "$ROUTES_JSON" | jq --arg slug "$slug" '.[$slug]'
}

register_or_update_slug() {
  local slug owner repo is_private secret_name update_pat token_input new_cfg

  read -r -p "Plugin slug (example: my-awesome-plugin): " slug
  read -r -p "GitHub owner/org: " owner
  read -r -p "GitHub repository: " repo

  slug="$(trim "$slug")"
  owner="$(trim "$owner")"
  repo="$(trim "$repo")"

  if [[ "$repo" == */* ]]; then
    if [[ "$repo" == "$owner/"* ]]; then
      echo -e "${YELLOW}WARN:${RESET} Repo should be only the repository name. Auto-correcting '$repo' -> '${repo#*/}'."
      repo="${repo#*/}"
    else
      echo -e "${RED}ERROR:${RESET} Repo must be repository name only (no slash)."
      echo "Example: owner='webmultipliers' repo='fouanalytics-for-wordpress'"
      return
    fi
  fi

  if [[ -z "$slug" || -z "$owner" || -z "$repo" ]]; then
    echo -e "${RED}ERROR:${RESET} slug, owner, and repo are required."
    return
  fi

  if ! [[ "$slug" =~ ^[a-z0-9._-]+$ ]]; then
    echo -e "${RED}ERROR:${RESET} invalid slug format. Use lowercase letters, numbers, dot, underscore, hyphen."
    return
  fi

  is_private="false"
  secret_name=""

  if ask_yes_no "Is this a private repo?"; then
    is_private="true"
    secret_name="GITHUB_PAT_${slug^^}"
    secret_name="$(echo "$secret_name" | tr '-' '_' | tr '.' '_')"
    echo "Token key for this slug: $secret_name"

    if ask_yes_no "Register or update PAT secret now?"; then
      read -r -s -p "Paste GitHub PAT (hidden): " token_input
      echo
      if [[ -z "$token_input" ]]; then
        echo -e "${RED}ERROR:${RESET} empty token; PAT not updated."
      else
        echo "$token_input" | npx --yes wrangler secret put "$secret_name" >/dev/null
        echo -e "${GREEN}OK:${RESET} Secret updated: $secret_name"
      fi
    else
      echo "PAT update skipped. Existing secret will be used if present."
    fi
  fi

  if echo "$ROUTES_JSON" | jq -e --arg slug "$slug" 'has($slug)' >/dev/null; then
    if ! ask_yes_no "Slug '$slug' already exists. Overwrite it?"; then
      echo "No changes applied for $slug."
      return
    fi
  fi

  if [[ "$is_private" == "true" ]]; then
    new_cfg="$(jq -n \
      --arg owner "$owner" \
      --arg repo "$repo" \
      --arg tokenKey "$secret_name" \
      '{owner: $owner, repo: $repo, tokenKey: $tokenKey, isPrivate: true}')"
  else
    new_cfg="$(jq -n \
      --arg owner "$owner" \
      --arg repo "$repo" \
      '{owner: $owner, repo: $repo, tokenKey: null, isPrivate: false}')"
  fi

  ROUTES_JSON="$(echo "$ROUTES_JSON" | jq --arg slug "$slug" --argjson cfg "$new_cfg" '.[$slug] = $cfg')"
  save_routes

  echo -e "${GREEN}OK:${RESET} Route saved for slug: $slug"
  echo "$ROUTES_JSON" | jq --arg slug "$slug" '.[$slug]'
}

print_header "4) Prompt-based KV Review and Repo Registration"
load_routes

while true; do
  echo
  echo "Choose an action:"
  echo "  1) Review KV routes (list all slugs)"
  echo "  2) Review one slug config"
  echo "  3) Register or update repo mapping (and optional PAT)"
  echo "  4) Reload routes from KV"
  echo "  5) Deploy/update Worker in Cloudflare now"
  echo "  6) Finish"
  read -r -p "Select option [1-6]: " menu_choice

  case "$(trim "$menu_choice")" in
    1)
      show_routes_summary
      ;;
    2)
      review_slug
      ;;
    3)
      register_or_update_slug
      ;;
    4)
      load_routes
      echo -e "${GREEN}OK:${RESET} Reloaded routes from KV."
      ;;
    5)
      deploy_worker_with_runtime_binding "$NAMESPACE_ID"
      echo -e "${GREEN}OK:${RESET} Worker updated on Cloudflare."
      ;;
    6)
      break
      ;;
    *)
      echo "Invalid option. Choose 1, 2, 3, 4, 5, or 6."
      ;;
  esac
done

print_header "Done"
echo -e "${GREEN}OK:${RESET} Setup wizard complete."
