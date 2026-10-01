#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

APP=/opt/mihu/app
DB=/var/lib/mihu/database.sqlite
DATA=/var/lib/mihu/data
BACKUPS=/var/backups/mihu
WEB=mihu-web.service
BOT=mihu-bot.service
PORT=3000
OFFSITE_MODE="${CLEAR_OFFSITE_MODE:-mounted}"

: "${CLEAR_RELEASE_COMMIT:?Set the reviewed, merged full commit SHA}"
: "${CLEAR_PREVIEW_FINGERPRINT:?Set the reviewed read-only preview fingerprint}"
: "${CLEAR_OPERATOR_ID:?Set the approved existing admin operator ID}"
if [ "$OFFSITE_MODE" = mounted ]; then
  : "${CLEAR_OFFSITE_MOUNT:?Set the mounted off-host backup directory}"
elif [ "$OFFSITE_MODE" != download ]; then
  echo "REFUSED: unsupported CLEAR_OFFSITE_MODE=$OFFSITE_MODE" >&2
  exit 1
fi

execution_started=0
writers_stopped=0
manifest_path=''

fail() { echo "REFUSED: $*" >&2; return 1; }

run_mihu() {
  sudo -u mihu env NODE_ENV=production APP_ENV=production \
    DATABASE_PATH="$DB" PRODUCTION_DATA_DIR="$DATA" \
    PRODUCTION_IDENTITY_VERIFIED=YES PRODUCTION_STORAGE_VERIFIED=YES \
    DATABASE_BACKUP_DIR="$BACKUPS" "$@"
}

preview_digest() {
  printf '%s' "$1" | /usr/bin/node -e 'let value="";process.stdin.on("data",chunk=>value+=chunk).on("end",()=>process.stdout.write(JSON.parse(value).fingerprint))'
}

show_scope() {
  printf '%s' "$1" | /usr/bin/node -e '
    let value="";
    process.stdin.on("data",chunk=>value+=chunk).on("end",()=>{
      const report=JSON.parse(value);
      const targets=["orders","order_creation_idempotency","wallet_transactions","topups","payouts","payout_ledger","user_order_spent_sync"];
      console.log(JSON.stringify({status:report.status,fingerprint:report.fingerprint,
        deleteCounts:Object.fromEntries(targets.map(table=>[table,report.counts[table]])),
        walletBalancesToZero:report.walletBalances[0],userMirrorsToZero:report.userMirrors[0],
        orderTotals:report.orderTotals[0],walletTransactions:report.walletTransactions,
        mirrors:report.mirrors,foreignKeyProblems:report.foreignKeyProblems}));
    });'
}

http_ready() {
  local login health attempt
  for ((attempt=1; attempt<=15; attempt++)); do
    login="$(curl -s --connect-timeout 2 --max-time 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/login" || true)"
    health="$(curl -s --connect-timeout 2 --max-time 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/healthz" || true)"
    echo "health attempt $attempt: login=$login healthz=$health"
    if systemctl is-active --quiet "$WEB" && systemctl is-active --quiet "$BOT" &&
       [ "$login" = 200 ] && [ "$health" = 200 ]; then return 0; fi
    sleep 2
  done
  return 1
}

on_failure() {
  local code="$1"
  trap - ERR INT TERM
  echo "FAILED; manifest=${manifest_path:-not-created}; execution_started=$execution_started" >&2
  if [ "$writers_stopped" -eq 0 ]; then
    echo 'Preflight failed before writer freeze; service state was not changed.' >&2
  elif [ "$execution_started" -eq 0 ]; then
    echo 'No clear was started; attempting to restore the original services.' >&2
    sudo systemctl start "$WEB" "$BOT" && http_ready ||
      echo 'Service recovery needs manual inspection.' >&2
  else
    echo 'Keep both writers stopped until DB state and backup are verified; no automatic DB restore.' >&2
    sudo systemctl stop "$WEB" "$BOT" || true
  fi
  exit "$code"
}
trap 'on_failure $?' ERR
trap 'on_failure 130' INT
trap 'on_failure 143' TERM

cd "$APP"
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail 'Tracked worktree is dirty'
[ "$(git rev-parse --verify HEAD)" = "$CLEAR_RELEASE_COMMIT" ] || fail 'Release SHA differs from reviewed version'
[ "$(systemctl show -p User --value "$WEB")" = mihu ] || fail 'Web identity mismatch'
[ "$(systemctl show -p WorkingDirectory --value "$WEB")" = "$APP" ] || fail 'Web working directory mismatch'
systemctl is-active --quiet "$WEB" || fail 'Web is not active before freeze'
systemctl is-active --quiet "$BOT" || fail 'Bot is not active before freeze'
[ -f "$DB" ] && [ -d "$DATA" ] && [ -d "$BACKUPS" ] || fail 'Production storage missing'
if [ "$OFFSITE_MODE" = mounted ]; then
  [ -d "$CLEAR_OFFSITE_MOUNT" ] && mountpoint -q "$CLEAR_OFFSITE_MOUNT" || fail 'Offsite mount is missing'
  [ "$(stat -c %d "$DB")" != "$(stat -c %d "$CLEAR_OFFSITE_MOUNT")" ] || fail 'Offsite path is on DB device'
fi
for command in node curl sha256sum fuser; do command -v "$command" >/dev/null || fail "Missing $command"; done

echo "Reviewed release: $CLEAR_RELEASE_COMMIT"
echo "Reviewed preview fingerprint: $CLEAR_PREVIEW_FINGERPRINT"
live_preview="$(run_mihu /usr/bin/node scripts/clearProductionFinancialHistory.js preview)"
echo 'Current read-only production scope before downtime:'
show_scope "$live_preview"
[ "$(preview_digest "$live_preview")" = "$CLEAR_PREVIEW_FINGERPRINT" ] || fail 'Live inventory changed; require new review before downtime'
read -r -p 'Confirm production identity, reviewed scope and scheduled writer freeze. Type YES: ' before_stop
[ "$before_stop" = YES ] || fail 'Production approval missing'

writers_stopped=1
sudo systemctl stop "$WEB" "$BOT"
! systemctl is-active --quiet "$WEB" && ! systemctl is-active --quiet "$BOT" || fail 'A writer is still active'
if sudo fuser "$DB" >/dev/null 2>&1; then fail 'Database has open handles'; fi
for suffix in -wal -shm -journal; do [ ! -e "$DB$suffix" ] || fail "SQLite sidecar remains: $suffix"; done

observed="$(run_mihu /usr/bin/node scripts/clearProductionFinancialHistory.js preview)"
observed_digest="$(preview_digest "$observed")"
[ "$observed_digest" = "$CLEAR_PREVIEW_FINGERPRINT" ] || fail 'Read-only inventory changed; require new review'

backup_result="$(run_mihu env BACKUP_CONFIRM=YES PRODUCTION_WRITES_DISABLED=YES \
  BACKUP_STORAGE_VERIFIED=YES /usr/bin/node scripts/backupDatabase.js)"
backup_name="$(/usr/bin/node -p 'JSON.parse(process.argv[1]).backupFile' "$backup_result")"
manifest_name="$(/usr/bin/node -p 'JSON.parse(process.argv[1]).manifestFile' "$backup_result")"
[ -n "$backup_name" ] && [ -n "$manifest_name" ] || fail 'Backup report incomplete'
backup_path="$BACKUPS/$backup_name"
manifest_path="$BACKUPS/$manifest_name"
[ -f "$backup_path" ] && [ -f "$manifest_path" ] || fail 'Backup or manifest missing'
mirror_name="mirrors-${backup_name%.sqlite}"
mirror_local="$BACKUPS/$mirror_name"
if [ "$OFFSITE_MODE" = mounted ]; then
  offsite_path="$CLEAR_OFFSITE_MOUNT/$backup_name"
  [ ! -e "$offsite_path" ] || fail 'Offsite destination already exists'
  sudo -u mihu install -m 600 -- "$backup_path" "$offsite_path"
  [ "$(run_mihu sha256sum "$backup_path" | cut -d ' ' -f 1)" = "$(run_mihu sha256sum "$offsite_path" | cut -d ' ' -f 1)" ] || fail 'Offsite checksum mismatch'
  mirror_offsite="$CLEAR_OFFSITE_MOUNT/$mirror_name"
  [ ! -e "$mirror_local" ] && [ ! -e "$mirror_offsite" ] || fail 'Mirror archive destination already exists'
  sudo -u mihu mkdir -m 700 -- "$mirror_local" "$mirror_offsite"
else
  transfer_id="financial-${backup_name%.sqlite}-$(date -u +%Y%m%dT%H%M%SZ)-${RANDOM}"
  transfer_tmp="/tmp/$transfer_id"
  transfer_root="/home/deploy/$transfer_id"
  sudo rm -rf -- "$transfer_tmp" "$transfer_root"
  sudo -u mihu mkdir -m 700 -- "$transfer_tmp"
  run_mihu /usr/bin/node scripts/prepareFinancialBackupTransfer.js \
    --backup-dir "$BACKUPS" --backup-file "$backup_name" --manifest-file "$manifest_name" \
    --data-dir "$DATA" --output-dir "$transfer_tmp" --backup-id "$transfer_id" \
    --release "$CLEAR_RELEASE_COMMIT" --fingerprint "$CLEAR_PREVIEW_FINGERPRINT" >/dev/null
  sudo chown -R deploy:deploy "$transfer_tmp"
  sudo mv -- "$transfer_tmp" "$transfer_root"
  sudo chmod 700 "$transfer_root"
  transfer_receipt="$transfer_root/receipt.json"
  echo "Download bundle: $transfer_root"
  echo "Windows: scp -r deploy@<VPS>:${transfer_root} <local-backup-directory>"
  echo "Windows: node scripts/verifyFinancialBackupReceipt.js --mode local --root <downloaded-directory> --receipt <downloaded-directory>/receipt.json"
  echo "Windows: scp <downloaded-directory>/receipt.json deploy@<VPS>:${transfer_receipt}"
  read -r -p 'After Windows hash verification and receipt upload, type TRANSFER_READY: ' transfer_ready
  [ "$transfer_ready" = TRANSFER_READY ] || fail 'Transfer receipt was not uploaded'
  sudo chown -R mihu:mihu "$transfer_root"
  run_mihu /usr/bin/node scripts/verifyFinancialBackupReceipt.js --mode vps \
    --root "$transfer_root" --receipt "$transfer_receipt" --release "$CLEAR_RELEASE_COMMIT" \
    --fingerprint "$CLEAR_PREVIEW_FINGERPRINT" >/dev/null
  manifest_path="$transfer_root/database.manifest.json"
  offsite_path="$transfer_receipt"
fi
for name in users.json orders.json topups.json payouts.json; do
  if sudo -u mihu test -f "$DATA/$name"; then
    if [ "$OFFSITE_MODE" = mounted ]; then
      sudo -u mihu install -m 600 -- "$DATA/$name" "$mirror_local/$name"
      sudo -u mihu install -m 600 -- "$DATA/$name" "$mirror_offsite/$name"
      [ "$(run_mihu sha256sum "$mirror_local/$name" | cut -d ' ' -f 1)" = \
        "$(run_mihu sha256sum "$mirror_offsite/$name" | cut -d ' ' -f 1)" ] || fail "Mirror checksum mismatch: $name"
    fi
  fi
done

echo "Verified local backup manifest: $manifest_path"
echo "Verified offsite evidence: $offsite_path"
if [ "$OFFSITE_MODE" = mounted ]; then echo "Verified mirror archives: $mirror_local and $mirror_offsite"; fi
echo 'Final deletion and zeroing scope; compare with the reviewed preview:'
show_scope "$observed"
read -r -p 'Independently confirm the off-host copy, manifest and reviewed totals. Type YES: ' offsite_confirm
[ "$offsite_confirm" = YES ] || fail 'Offsite verification not confirmed'
read -r -p 'Authorize irreversible financial-history clear from the reviewed snapshot. Type CLEAR_ALL_FINANCIAL_HISTORY: ' clear_confirm
[ "$clear_confirm" = CLEAR_ALL_FINANCIAL_HISTORY ] || fail 'Explicit clear authorization missing'

execution_started=1
if [ "$OFFSITE_MODE" = download ]; then
  result="$(run_mihu env PRODUCTION_WRITES_DISABLED=YES OFFSITE_BACKUP_VERIFIED=YES \
    CLEAR_CONFIRM="$clear_confirm" CLEAR_PREVIEW_FINGERPRINT="$CLEAR_PREVIEW_FINGERPRINT" \
    CLEAR_RELEASE_COMMIT="$CLEAR_RELEASE_COMMIT" CLEAR_OPERATOR_ID="$CLEAR_OPERATOR_ID" \
    CLEAR_BACKUP_MANIFEST="$manifest_path" CLEAR_OFFSITE_COPY="$offsite_path" \
    CLEAR_TRANSFER_ROOT="$transfer_root" CLEAR_TRANSFER_RECEIPT="$transfer_receipt" \
    /usr/bin/node scripts/clearProductionFinancialHistory.js execute)"
else
  result="$(run_mihu env PRODUCTION_WRITES_DISABLED=YES OFFSITE_BACKUP_VERIFIED=YES \
    CLEAR_CONFIRM="$clear_confirm" CLEAR_PREVIEW_FINGERPRINT="$CLEAR_PREVIEW_FINGERPRINT" \
    CLEAR_RELEASE_COMMIT="$CLEAR_RELEASE_COMMIT" CLEAR_OPERATOR_ID="$CLEAR_OPERATOR_ID" \
    CLEAR_BACKUP_MANIFEST="$manifest_path" CLEAR_OFFSITE_COPY="$offsite_path" \
    CLEAR_MIRROR_BACKUP_DIR="$mirror_local" CLEAR_OFFSITE_MIRROR_DIR="$mirror_offsite" \
    /usr/bin/node scripts/clearProductionFinancialHistory.js execute)"
fi
echo "$result"
printf '%s' "$result" | /usr/bin/node -e 'let value="";process.stdin.on("data",chunk=>value+=chunk).on("end",()=>{if(JSON.parse(value).status!=="CLEARED_AND_VERIFIED")process.exit(1)})'

mirrors="$(run_mihu env PRODUCTION_WRITES_DISABLED=YES OFFSITE_BACKUP_VERIFIED=YES \
  CLEAR_CONFIRM="$clear_confirm" CLEAR_PREVIEW_FINGERPRINT="$CLEAR_PREVIEW_FINGERPRINT" \
  CLEAR_BACKUP_MANIFEST="$manifest_path" CLEAR_OFFSITE_COPY="$offsite_path" \
  CLEAR_TRANSFER_ROOT="${transfer_root:-}" CLEAR_TRANSFER_RECEIPT="${transfer_receipt:-}" \
  /usr/bin/node scripts/clearProductionFinancialHistory.js sync-mirrors)"
printf '%s' "$mirrors" | /usr/bin/node -e 'let value="";process.stdin.on("data",chunk=>value+=chunk).on("end",()=>{if(JSON.parse(value).status!=="FINANCIAL_MIRRORS_SYNCED")process.exit(1)})'

post="$(run_mihu /usr/bin/node scripts/clearProductionFinancialHistory.js preview)"
printf '%s' "$post" | /usr/bin/node -e '
  let value="";
  process.stdin.on("data",chunk=>value+=chunk).on("end",()=>{
    const report=JSON.parse(value);
    const tables=["orders","order_creation_idempotency","wallet_transactions","topups","payouts","payout_ledger","user_order_spent_sync"];
    if(tables.some(table=>report.counts[table]!==0)||report.foreignKeyProblems!==0 ||
       [report.walletBalances[0],report.userMirrors[0]].some(row=>Object.values(row).some(amount=>amount!==0))) process.exit(1);
  });'

sudo systemctl start "$WEB" "$BOT"
http_ready || fail 'Service or dual HTTP health check failed; keep writers stopped for manual review'
trap - ERR INT TERM
echo "CLEAR_AND_HEALTH_PASS release=$CLEAR_RELEASE_COMMIT manifest=$manifest_path"