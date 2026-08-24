#!/usr/bin/env bash
# Delete and then prove absence of every billable DigitalOcean resource owned
# by one public-CLI E2E deploy. Matching is exact: the per-run tag for droplets
# and the Terraform-generated name for firewalls. The tag itself is metadata,
# so a token without tag-delete permission may leave it behind without hiding
# the stronger zero-billable-resource result.
set -Eeuo pipefail
set +x

DEPLOY_ID="${1:?usage: digitalocean-e2e-cleanup.sh <deploy-id>}"
[[ "$DEPLOY_ID" =~ ^adp-[a-z0-9][a-z0-9-]{5,55}$ ]] || {
  echo "invalid deploy id: $DEPLOY_ID" >&2
  exit 2
}
: "${DIGITALOCEAN_TOKEN:?DIGITALOCEAN_TOKEN is required}"

API_ROOT="${DIGITALOCEAN_API_ROOT:-https://api.digitalocean.com/v2}"
RESOURCE_NAME="aideploy-$DEPLOY_ID"
RESOURCE_TAG="$RESOURCE_NAME"

api_get() {
  local url="$1"
  curl --fail --silent --show-error --location \
    --connect-timeout 10 --max-time 60 \
    --retry 4 --retry-delay 2 --retry-all-errors \
    -H "Authorization: Bearer $DIGITALOCEAN_TOKEN" \
    "$url"
}

api_delete() {
  local url="$1"
  local status
  status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --connect-timeout 10 --max-time 60 \
    --retry 4 --retry-delay 2 --retry-all-errors \
    -X DELETE \
    -H "Authorization: Bearer $DIGITALOCEAN_TOKEN" \
    "$url")"
  if [ "$status" != "204" ] && [ "$status" != "404" ]; then
    echo "DigitalOcean delete failed with HTTP $status" >&2
    return 1
  fi
}

list_ids() {
  local kind="$1"
  local url payload next
  if [ "$kind" = "droplets" ]; then
    url="$API_ROOT/droplets?tag_name=$(jq -rn --arg value "$RESOURCE_TAG" '$value|@uri')&per_page=200"
  else
    url="$API_ROOT/firewalls?per_page=200"
  fi
  while [ -n "$url" ]; do
    payload="$(api_get "$url")"
    if [ "$kind" = "droplets" ]; then
      jq -r --arg tag "$RESOURCE_TAG" '.droplets[]? | select(any(.tags[]?; . == $tag)) | .id' <<<"$payload"
    else
      jq -r --arg name "$RESOURCE_NAME" '.firewalls[]? | select(.name == $name) | .id' <<<"$payload"
    fi
    next="$(jq -r '.links.pages.next // empty' <<<"$payload")"
    if [ -n "$next" ] && [[ "$next" != "$API_ROOT/"* && "$next" != "$API_ROOT?"* ]]; then
      echo "DigitalOcean returned an unexpected pagination URL" >&2
      return 1
    fi
    url="$next"
  done
}

list_tag() {
  local url payload next
  url="$API_ROOT/tags?per_page=200"
  while [ -n "$url" ]; do
    payload="$(api_get "$url")"
    jq -r --arg tag "$RESOURCE_TAG" '.tags[]? | select(.name == $tag) | .name' <<<"$payload"
    next="$(jq -r '.links.pages.next // empty' <<<"$payload")"
    if [ -n "$next" ] && [[ "$next" != "$API_ROOT/"* && "$next" != "$API_ROOT?"* ]]; then
      echo "DigitalOcean returned an unexpected pagination URL" >&2
      return 1
    fi
    url="$next"
  done
}

delete_survivors() {
  local kind="$1"
  local id
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    [[ "$id" =~ ^[0-9a-f-]+$ ]] || {
      echo "DigitalOcean returned an invalid $kind id" >&2
      return 1
    }
    echo "Deleting surviving DigitalOcean $kind resource $id ($RESOURCE_NAME)"
    api_delete "$API_ROOT/$kind/$id"
  done < <(list_ids "$kind")
}

delete_survivors droplets
delete_survivors firewalls

for _ in $(seq 1 30); do
  droplet_ids="$(list_ids droplets)"
  firewall_ids="$(list_ids firewalls)"
  if [ -z "$droplet_ids" ] && [ -z "$firewall_ids" ]; then
    # The per-run tag is non-billable. Delete it when the cleanup credential
    # permits that, but never misreport metadata permission as leaked compute.
    tag="$(list_tag)"
    if [ -z "$tag" ]; then
      echo "DigitalOcean billable-resource cleanup: PASS (zero droplets or firewalls; per-run metadata tag absent)"
      exit 0
    fi
    encoded_tag="$(jq -rn --arg value "$RESOURCE_TAG" '$value|@uri')"
    status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
      --connect-timeout 10 --max-time 60 \
      --retry 4 --retry-delay 2 --retry-all-errors \
      -X DELETE -H "Authorization: Bearer $DIGITALOCEAN_TOKEN" \
      "$API_ROOT/tags/$encoded_tag")"
    case "$status" in
      204|404)
        ;;
      403)
        echo "DigitalOcean billable-resource cleanup: PASS (zero droplets or firewalls)"
        echo "WARNING: non-billable per-run metadata tag retained because cleanup token lacks tag-delete permission" >&2
        exit 0
        ;;
      *)
        echo "Could not delete per-run DigitalOcean tag (HTTP $status)" >&2
        exit 1
        ;;
    esac
    # Re-list on the next pass so success means the tag is observably absent,
    # not merely that DigitalOcean accepted the asynchronous deletion.
    sleep 1
  fi
  sleep 5
done

echo "DigitalOcean cleanup timed out; billable exact-tag survivors remain" >&2
list_ids droplets >&2 || true
list_ids firewalls >&2 || true
exit 1
