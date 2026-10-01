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

: "${CLEAR_RELEASE_COMMIT:?Set the reviewed, merged full commit SHA}"
: "${CLEAR_PREVIEW_FINGERPRINT:?Set the reviewed read-only preview fingerprint}"
: "${CLEAR_OPERATOR_ID:?Set the approved existing admin operator ID}"
: "${CLEAR_OFFSITE_MOUNT:?Set the mounted off-host backup directory}"

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
  if [ "$writers_stopped" -eq 1 ] && [ "$execution_started" -eq 0 ]; then
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
[ -d "$CLEAR_OFFSITE_MOUNT" ] && mountpoint -q "$CLEAR_OFFSITE_MOUNT" || fail 'Offsite mount is missing'
[ "$(stat -c %d "$DB")" != "$(stat -c %d "$CLEAR_OFFSITE_MOUNT")" ] || fail 'Offsite path is on DB device'
for command in node curl sha256sum fuser; do command -v "$command" >/dev/null || fail "Missing $command"; done

echo "Reviewed release: $CLEAR_RELEASE_COMMIT"
echo "Reviewed preview fingerprint: $CLEAR_PREVIEW_FINGERPRINT"
read -r -p 'Confirm production identity, reviewed scope and scheduled writer freeze. Type YES: ' before_stop
[ "$before_stop" = YES ] || fail 'Production approval missing'

sudo systemctl stop "$WEB" "$BOT"
writers_stopped=1
! systemctl is-active --quiet "$WEB" && ! systemctl is-active --quiet "$BOT" || fail 'A writer is still active'
if sudo fuser "$DB" >/dev/null 2>&1; then fail 'Database has open handles'; fi
for suffix in -wal -shm -journal; do [ ! -e "$DB$suffix" ] || fail "SQLite sidecar remains: $suffix"; done

observed="$(run_mihu /usr/bin/node scripts/clearProductionFinancialHistory.js preview)"
observed_digest="$(printf '%s' "$observed" | /usr/bin/node -e 'let value="";process.stdin.on("data",chunk=>value+=chunk).on("end",()=>process.stdout.write(JSON.parse(value).fingerprint))')"
[ "$observed_digest" = "$CLEAR_PREVIEW_FINGERPRINT" ] || fail 'Read-only inventory changed; require new review'

backup_result="$(run_mihu env BACKUP_CONFIRM=YES PRODUCTION_WRITES_DISABLED=YES \
  BACKUP_STORAGE_VERIFIED=YES /usr/bin/node scripts/backupDatabase.js)"
backup_name="$(/usr/bin/node -p 'JSON.parse(process.argv[1]).backupFile' "$backup_result")"
manifest_name="$(/usr/bin/node -p 'JSON.parse(process.argv[1]).manifestFile' "$backup_result")"
[ -n "$backup_name" ] && [ -n "$manifest_name" ] || fail 'Backup report incomplete'
backup_path="$BACKUPS/$backup_name"
manifest_path="$BACKUPS/$manifest_name"
[ -f "$backup_path" ] && [ -f "$manifest_path" ] || fail 'Backup or manifest missing'
offsite_path="$CLEAR_OFFSITE_MOUNT/$backup_name"
[ ! -e "$offsite_path" ] || fail 'Offsite destination already exists'
sudo -u mihu install -m 600 -- "$backup_path" "$offsite_path"
[ "$(run_mihu sha256sum "$backup_path" | cut -d ' ' -f 1)" = "$(run_mihu sha256sum "$offsite_path" | cut -d ' ' -f 1)" ] || fail 'Offsite checksum mismatch'

mirror_name="mirrors-${backup_name%.sqlite}"
mirror_local="$BACKUPS/$mirror_name"
mirror_offsite="$CLEAR_OFFSITE_MOUNT/$mirror_name"
[ ! -e "$mirror_local" ] && [ ! -e "$mirror_offsite" ] || fail 'Mirror archive destination already exists'
sudo -u mihu mkdir -m 700 -- "$mirror_local" "$mirror_offsite"
for name in users.json orders.json topups.json payouts.json; do
  if sudo -u mihu test -f "$DATA/$name"; then
    sudo -u mihu install -m 600 -- "$DATA/$name" "$mirror_local/$name"
    sudo -u mihu install -m 600 -- "$DATA/$name" "$mirror_offsite/$name"
    [ "$(run_mihu sha256sum "$mirror_local/$name" | cut -d ' ' -f 1)" = \
      "$(run_mihu sha256sum "$mirror_offsite/$name" | cut -d ' ' -f 1)" ] || fail "Mirror checksum mismatch: $name"
  fi
done

echo "Verified local backup manifest: $manifest_path"
echo "Verified offsite copy: $offsite_path"
echo "Verified mirror archives: $mirror_local and $mirror_offsite"
read -r -p 'Independently confirm the off-host copy, manifest and reviewed totals. Type YES: ' offsite_confirm
[ "$offsite_confirm" = YES ] || fail 'Offsite verification not confirmed'
read -r -p 'Authorize irreversible financial-history clear from the reviewed snapshot. Type CLEAR_ALL_FINANCIAL_HISTORY: ' clear_confirm
[ "$clear_confirm" = CLEAR_ALL_FINANCIAL_HISTORY ] || fail 'Explicit clear authorization missing'

execution_started=1
result="$(run_mihu env PRODUCTION_WRITES_DISABLED=YES OFFSITE_BACKUP_VERIFIED=YES \
  CLEAR_CONFIRM="$clear_confirm" CLEAR_PREVIEW_FINGERPRINT="$CLEAR_PREVIEW_FINGERPRINT" \
  CLEAR_OPERATOR_ID="$CLEAR_OPERATOR_ID" CLEAR_BACKUP_MANIFEST="$manifest_path" \
  CLEAR_OFFSITE_COPY="$offsite_path" CLEAR_MIRROR_BACKUP_DIR="$mirror_local" \
  CLEAR_OFFSITE_MIRROR_DIR="$mirror_offsite" /usr/bin/node scripts/clearProductionFinancialHistory.js execute)"
echo "$result"
printf '%s' "$result" | /usr/bin/node -e 'let value="";process.stdin.on("data",chunk=>value+=chunk).on("end",()=>{if(JSON.parse(value).status!=="CLEARED_AND_VERIFIED")process.exit(1)})'

mirrors="$(run_mihu env PRODUCTION_WRITES_DISABLED=YES OFFSITE_BACKUP_VERIFIED=YES \
  CLEAR_CONFIRM="$clear_confirm" CLEAR_PREVIEW_FINGERPRINT="$CLEAR_PREVIEW_FINGERPRINT" \
  CLEAR_BACKUP_MANIFEST="$manifest_path" CLEAR_OFFSITE_COPY="$offsite_path" \
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