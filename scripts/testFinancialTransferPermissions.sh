#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if ! command -v sudo >/dev/null 2>&1 || ! id deploy >/dev/null 2>&1 || ! id mihu >/dev/null 2>&1; then
  echo 'TRANSFER_PERMISSION_TEST_SKIPPED: deploy/mihu identities are unavailable'
  exit 0
fi

root="$(mktemp -d /var/tmp/mihu-transfer-permissions.XXXXXX)"
sudo chown deploy:mihu "$root"
sudo chmod 2770 "$root"
cleanup() { sudo rm -rf -- "$root"; }
trap cleanup EXIT

check_access() {
  local stage="$1" user="$2" path="$3"
  shift 3
  local exit_code
  if sudo -u "$user" "$@"; then
    exit_code=0
  else
    exit_code=$?
  fi
  if [ "$exit_code" -ne 0 ]; then
    echo "TRANSFER_PERMISSION_TEST_FAILED stage=$stage path=$path user=$user exit=$exit_code" >&2
    exit 1
  fi
}

check_denied() {
  local stage="$1" user="$2" path="$3"
  shift 3
  if sudo -u "$user" "$@"; then
    echo "TRANSFER_PERMISSION_TEST_FAILED stage=$stage path=$path user=$user expected=denied exit=0" >&2
    exit 1
  fi
}

check_access parent-traverse deploy "$root" test -x "$root"
check_access parent-traverse mihu "$root" test -x "$root"
sudo -u deploy mkdir -m 2770 -- "$root/bundle"
sudo chown deploy:mihu "$root/bundle"
sudo -u deploy sh -c "printf '%s\\n' bundle > '$root/bundle/transfer-manifest.json'"
sudo chown deploy:mihu "$root/bundle/transfer-manifest.json"
sudo chmod 640 "$root/bundle/transfer-manifest.json"

check_access bundle-read deploy "$root/bundle/transfer-manifest.json" test -r "$root/bundle/transfer-manifest.json"
check_access bundle-write deploy "$root/bundle" test -w "$root/bundle"
check_access bundle-traverse mihu "$root/bundle" test -x "$root/bundle"
check_access bundle-read mihu "$root/bundle/transfer-manifest.json" test -r "$root/bundle/transfer-manifest.json"

if id nobody >/dev/null 2>&1; then
  check_denied nobody-bundle-read nobody "$root/bundle/transfer-manifest.json" test -r "$root/bundle/transfer-manifest.json"
fi

sudo -u deploy sh -c "printf '%s\\n' receipt > '$root/bundle/receipt.json'"
sudo chgrp mihu "$root/bundle/receipt.json"
sudo chmod 640 "$root/bundle/receipt.json"
check_access receipt-read deploy "$root/bundle/receipt.json" test -r "$root/bundle/receipt.json"
check_access receipt-read mihu "$root/bundle/receipt.json" test -r "$root/bundle/receipt.json"
check_access marker-write mihu "$root/bundle/.receipt-accepted" sh -c "printf '%s\\n' accepted > '$root/bundle/.receipt-accepted'"
check_access marker-read mihu "$root/bundle/.receipt-accepted" test -r "$root/bundle/.receipt-accepted"

if id nobody >/dev/null 2>&1; then
  check_denied nobody-receipt-read nobody "$root/bundle/receipt.json" test -r "$root/bundle/receipt.json"
fi

echo 'TRANSFER_PERMISSION_TEST_PASS'