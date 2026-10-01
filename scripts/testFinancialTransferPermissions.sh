#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if ! command -v sudo >/dev/null 2>&1 || ! id deploy >/dev/null 2>&1 || ! id mihu >/dev/null 2>&1; then
  echo 'TRANSFER_PERMISSION_TEST_SKIPPED: deploy/mihu identities are unavailable'
  exit 0
fi

root="$(mktemp -d /tmp/mihu-transfer-permissions.XXXXXX)"
cleanup() { sudo rm -rf -- "$root"; }
trap cleanup EXIT

sudo -u deploy mkdir -m 2770 -- "$root/bundle"
sudo chown deploy:mihu "$root/bundle"
sudo -u deploy sh -c "printf '%s\\n' bundle > '$root/bundle/transfer-manifest.json'"
sudo chown deploy:mihu "$root/bundle/transfer-manifest.json"
sudo chmod 640 "$root/bundle/transfer-manifest.json"

sudo -u deploy test -r "$root/bundle/transfer-manifest.json"
sudo -u deploy test -w "$root/bundle"
sudo -u mihu test -x "$root/bundle"
sudo -u mihu test -r "$root/bundle/transfer-manifest.json"

if id nobody >/dev/null 2>&1; then
  if sudo -u nobody test -r "$root/bundle/transfer-manifest.json"; then
    echo 'TRANSFER_PERMISSION_TEST_FAILED: unprivileged user can read bundle' >&2
    exit 1
  fi
fi

sudo -u deploy sh -c "printf '%s\\n' receipt > '$root/bundle/receipt.json'"
sudo chgrp mihu "$root/bundle/receipt.json"
sudo chmod 640 "$root/bundle/receipt.json"
sudo -u deploy test -r "$root/bundle/receipt.json"
sudo -u mihu test -r "$root/bundle/receipt.json"

echo 'TRANSFER_PERMISSION_TEST_PASS'