#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_SCRIPT="$SCRIPT_DIR/deploy-salary-settings.sh"
TARGET="cf870e1e0de6f69d49520ebbb589e3a0ead4b4a4"
PREVIOUS="ad52aad2b3bb26ab28c0fafd0f6ad9b3eadf7a13"
STAGING_RELEASE="$TARGET"

bash -n "$DEPLOY_SCRIPT"
if grep -q 'clearProductionFinancialHistory\|CLEAR_ALL_FINANCIAL_HISTORY' "$DEPLOY_SCRIPT"; then
  echo 'deployment script must never invoke the financial cleanup runner' >&2
  exit 1
fi

make_mock() {
  local root="$1" bin="$1/bin" app="$1/app" state="$1/state" envdir="$1/env"
  mkdir -p "$bin" "$app/.git" "$state" "$envdir" "$root/data" "$root/backups" "$root/transfers"
  mkdir -p "$app/scripts" "$app/utils"
  printf '{"engines":{"node":">=24.0.0 <25"},"dependencies":{"csv-parse":"^7.0.3","multer":"^1.4.5-lts.2"}}\n' > "$app/package.json"
  printf '{"lockfileVersion":3,"packages":{"":{"dependencies":{"csv-parse":"^7.0.3","multer":"^1.4.5-lts.2"}}}}\n' > "$app/package-lock.json"
  printf "const backupPurpose = 'local-transfer-staging-only';\n" > "$app/scripts/backupDatabase.js"
  for file in utils/runtimePaths.js utils/productionDatabaseConfig.js utils/backupContract.js utils/databaseReadiness.js; do printf '// mock %s\n' "$file" > "$app/$file"; done
    mkdir -p "$app/scripts"
    printf '#!/usr/bin/env bash\necho TRANSFER_PERMISSION_TEST_SKIPPED\n' > "$app/scripts/testFinancialTransferPermissions.sh"
    chmod +x "$app/scripts/testFinancialTransferPermissions.sh"
  : > "$root/prod.sqlite"
  cat > "$envdir/common.env" <<EOF
NODE_ENV=production
APP_ENV=production
DATABASE_PATH=$root/prod.sqlite
PRODUCTION_DATA_DIR=$root/data
DATABASE_BACKUP_DIR=$root/backups
PORT=3210
SESSION_SECRET=mock-session-secret
PAYROLL_DATA_ENCRYPTION_KEY=mock-payroll-key
PLATFORM_SUPERUSER_ID=604610298581876746
DISCORD_CLIENT_ID=mock-client
DISCORD_CLIENT_SECRET=mock-secret
DISCORD_CALLBACK_URL=https://example.invalid/auth/discord/callback
PUBLIC_BASE_URL=https://example.invalid
WEB_LISTEN_HOST=127.0.0.1
EOF
  cat > "$envdir/web.env" <<'EOF'
MIHU_RUNTIME_ROLE=web
SALARY_SCHEDULER_ENABLED=false
EOF
  cat > "$envdir/bot.env" <<'EOF'
MIHU_RUNTIME_ROLE=bot
DISCORD_ENABLED=true
DISCORD_BOT_TOKEN=mock-token
GUILD_MAIN_ID=123456789012345678
GUILD_STAFF_ID=123456789012345679
EOF
  printf '%s\n' "$PREVIOUS" > "$state/head"
  printf 'active\n' > "$state/mihu-web.service"
  printf 'active\n' > "$state/mihu-bot.service"
  printf '0\n' > "$state/npm-ci-count"
  printf '0\n' > "$state/readiness-count"
  printf '0\n' > "$state/fingerprint-count"

  cat > "$bin/git" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
  if [ "${1:-}" = --no-pager ]; then shift; fi
cmd="${1:-}"; shift || true
case "$cmd" in
  status) exit 0 ;;
  rev-parse)
    [ "${1:-}" = --is-inside-work-tree ] && { echo true; exit 0; }
    [ "${1:-}" = --verify ] && [ "${2:-}" = HEAD ] && { cat "$MOCK_STATE_DIR/head"; exit 0; }
    ;;
  fetch) exit 0 ;;
  cat-file) exit 0 ;;
  merge-base) exit 0 ;;
  diff)
    if [ "${1:-}" = --stat ]; then echo 'salary schema and services'; exit 0; fi
    if [ "${1:-}" = --name-only ]; then
      printf '%s\n' database.js utils/salarySchema.js utils/databaseReadiness.js services/payoutService.js services/salaryScheduler.js package.json package-lock.json
      exit 0
    fi
    ;;
  checkout)
    [ "${1:-}" = --detach ] || exit 1
    printf '%s\n' "${2:?}" > "$MOCK_STATE_DIR/head"
    exit 0
    ;;
  show)
    case "${1:-}" in
      *:package.json) cat "$MOCK_APP_DIR/package.json" ;;
      *:package-lock.json) cat "$MOCK_APP_DIR/package-lock.json" ;;
      *) exit 1 ;;
    esac
    exit 0
    ;;
  archive)
    shift
    tar -C "$MOCK_APP_DIR" -cf - "$@"
    exit 0
    ;;
  archive)
    shift
    tar -C "$MOCK_APP_DIR" -cf - "$@"
    exit 0
    ;;
esac
exit 1
MOCK

  cat > "$bin/systemctl" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
state="$MOCK_STATE_DIR"
cmd="${1:-}"; shift || true
case "$cmd" in
  cat)
    cat <<UNIT
[Service]
User=mihu
Group=mihu
WorkingDirectory=$MOCK_APP_DIR
EnvironmentFile=$MOCK_COMMON_ENV
EnvironmentFile=$MOCK_WEB_ENV
UNIT
    [ "${1:-}" != mihu-bot.service ] || echo "EnvironmentFile=$MOCK_BOT_ENV"
    ;;
  show)
    key="${2:-}"; service="${4:-${3:-}}"
    case "$key" in
      User) echo mihu ;;
      Group) echo mihu ;;
      WorkingDirectory) echo "$MOCK_APP_DIR" ;;
      ExecStart) if [ "$service" = mihu-web.service ]; then echo '/usr/bin/npm start'; else echo '/usr/bin/node botRunner.js'; fi ;;
      EnvironmentFiles) if [ "$service" = mihu-web.service ]; then echo "$MOCK_COMMON_ENV $MOCK_WEB_ENV"; else echo "$MOCK_COMMON_ENV $MOCK_BOT_ENV"; fi ;;
      *) exit 1 ;;
    esac
    ;;
  is-active)
    quiet=0; [ "${1:-}" != --quiet ] || { quiet=1; shift; }
    value="$(cat "$state/${1:?}")"
    [ "$value" = active ] && { [ "$quiet" -eq 1 ] || echo active; exit 0; }
    [ "$quiet" -eq 1 ] || echo inactive
    exit 3
    ;;
  stop|start)
    value=inactive; [ "$cmd" != start ] || value=active
    for service in "$@"; do printf '%s\n' "$value" > "$state/$service"; done
    ;;
  *) exit 1 ;;
esac
MOCK

  cat > "$bin/systemd-run" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
cmd=(); workdir="$MOCK_APP_DIR"; envfiles=(); overrides=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --quiet|--wait|--pipe|--collect|--service-type=exec|--uid=*|--gid=*) shift ;;
    --setenv=*) overrides+=("${1#--setenv=}"); shift ;;
    -p)
      property="${2:-}"; shift 2
      case "$property" in
        WorkingDirectory=*) workdir="${property#WorkingDirectory=}" ;;
        EnvironmentFile=*)
          envfiles+=("${property#EnvironmentFile=}")
          printf '%s\n' "$property" >> "$MOCK_STATE_DIR/environment-properties.log"
          ;;
      esac
      ;;
    *) cmd=("$@"); break ;;
  esac
done
for envfile in "${envfiles[@]}"; do set -a; . "$envfile"; set +a; done
for item in "${overrides[@]}"; do export "$item"; done
cd "$workdir"
program="${cmd[0]:-}"
if [[ "$program" == *npm ]]; then
  if [ "${cmd[1]:-}" = run ] && [ "${cmd[2]:-}" = db:readiness ]; then
    count="$(cat "$MOCK_STATE_DIR/readiness-count")"; count=$((count+1)); printf '%s\n' "$count" > "$MOCK_STATE_DIR/readiness-count"
    if [ "${MOCK_FAIL_READINESS_FIRST:-0}" = 1 ] && [ "$count" -eq 1 ]; then exit 1; fi
    exit 0
  fi
  if [ "${cmd[1]:-}" = run ] && [ "${cmd[2]:-}" = db:preflight ]; then
    [ "${MOCK_FAIL_PREFLIGHT:-0}" != 1 ] || exit 1
    printf '{"status":"PASS","mode":"INITIALIZATION"}\n'
    exit 0
  fi
fi
if [[ "$program" == *node || "$program" == node ]]; then
  if [[ "${cmd[1]:-}" == *backupDatabase.js ]]; then
    backup_path="$DATABASE_BACKUP_DIR/mihu-database-mock.sqlite"
    manifest_path="$backup_path.manifest.json"
    printf 'mock-sqlite-backup' > "$backup_path"
    digest="$(node -e 'const fs=require("fs"),crypto=require("crypto");process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$backup_path")"
    purpose_mode="${MOCK_BACKUP_PURPOSE_MODE:-staging}"
    case "$purpose_mode" in
      staging)
        printf '{"contractVersion":1,"backupFile":"mihu-database-mock.sqlite","backupSha256":"%s","backupPurpose":"local-transfer-staging-only","integrity":"ok"}\n' "$digest" > "$manifest_path"
        ;;
      external)
        printf '{"contractVersion":1,"backupFile":"mihu-database-mock.sqlite","backupSha256":"%s","backupPurpose":"verified-backup-storage","integrity":"ok"}\n' "$digest" > "$manifest_path"
        ;;
      missing)
        printf '{"contractVersion":1,"backupFile":"mihu-database-mock.sqlite","backupSha256":"%s","integrity":"ok"}\n' "$digest" > "$manifest_path"
        ;;
      *)
        echo "unsupported MOCK_BACKUP_PURPOSE_MODE=$purpose_mode" >&2
        exit 1
        ;;
    esac
    [ "${MOCK_BACKUP_OUTPUT_NOISE:-0}" != 1 ] || printf 'backup-helper-finished\n'
    printf '{"backupFile":"mihu-database-mock.sqlite","manifestFile":"mihu-database-mock.sqlite.manifest.json","backupSha256":"%s","integrity":"ok"}\n' "$digest"
    exit 0
  fi
  if [[ "${cmd[1]:-}" == *verifySalaryBackupStaging.js ]]; then
    exec "${cmd[0]}" "${cmd[@]:1}"
  fi
  if [ "${cmd[1]:-}" = -p ] && [ "${cmd[2]:-}" = process.version ]; then echo v24.21.0; exit 0; fi
  if [ "${cmd[1]:-}" = -e ]; then
    code="${cmd[2]:-}"
    if [[ "$code" == *SALARY_SCHEDULER_ENABLED* ]]; then
      printf 'MIHU_JSON:{"role":"%s","enabled":"%s"}\n' "${MIHU_RUNTIME_ROLE:-}" "${SALARY_SCHEDULER_ENABLED:-}"
      exit 0
    fi
    if [[ "$code" == *process.env.MIHU_RUNTIME_ROLE* ]]; then printf 'MIHU_JSON:{"role":"%s"}\n' "${MIHU_RUNTIME_ROLE:-}"; exit 0; fi
  fi
  if [ "${cmd[1]:-}" = - ]; then
    code="$(cat)"
      if [[ "$code" == *runProductionPreflight* ]]; then
        status="${MOCK_PREFLIGHT_STATUS:-PASS}"
        schema=PASS; [ "${MOCK_PREFLIGHT_SCHEMA_FAIL:-0}" != 1 ] || schema=FAIL
        wildcard=PASS; payout=PASS; staffing=STAFFED; breakglass=ADMIN
        if [ "$status" = ACTION_REQUIRED ]; then wildcard=FAIL; payout=FAIL; staffing=NOT_STAFFED; breakglass=MEMBER; fi
        [ "${MOCK_PREFLIGHT_UNKNOWN_GOVERNANCE_VALUE:-0}" != 1 ] || wildcard=UNKNOWN
        unknown=''; [ "${MOCK_PREFLIGHT_UNKNOWN_CHECK:-0}" != 1 ] || unknown=',"futureUnknownCheck":"FAIL"'
        printf 'MIHU_JSON:{"status":"%s","mode":"%s","checks":{"integrity":"PASS","schema":"%s","adminRole":"PRESENT","adminAssignedUsers":1,"adminStoredPermissionCount":12,"adminEffectiveCapabilities":{"members":"PASS","staff":"PASS","orders":"PASS","roles":"PASS","system_settings":"PASS","audit_logs":"PASS","system_health":"PASS","analytics":"PASS","discord_control":"PASS","payroll_payout":"PASS"},"breakGlassConfigured":"CONFIGURED","breakGlassUserPresent":"YES","breakGlassStoredRole":"%s","resolverWildcard":"PASS","wildcardRoles":"%s","payoutDutyCoverage":"%s","staffing":"%s","roleAssignments":"PASS","permissionJson":"PASS","sqliteBusyTimeout":"PASS","deploymentVerified":false,"productionRbacVerified":false%s},"goLive":{"rbac":"%s"},"unknownPermissions":{},"invalidPermissionSets":[]}\n' \
          "$status" "${PRODUCTION_PREFLIGHT_MODE:-INITIALIZATION}" "$schema" "$breakglass" "$wildcard" "$payout" "$staffing" "$unknown" "$([ "$status" = PASS ] && echo RBAC_STAFFED || echo NO_GO)"
        exit 0
      fi
    if [[ "$code" == *databasePath:cfg.databasePath* ]]; then
      printf 'MIHU_JSON:{"databasePath":"%s","dataDir":"%s","backupDir":"%s","port":"%s"}\n' "$DATABASE_PATH" "$PRODUCTION_DATA_DIR" "$DATABASE_BACKUP_DIR" "$PORT"
      exit 0
    fi
    if [[ "$code" == *tableSpecs* ]]; then
      count="$(cat "$MOCK_STATE_DIR/fingerprint-count")"; count=$((count+1)); printf '%s\n' "$count" > "$MOCK_STATE_DIR/fingerprint-count"
      digest=same; if [ "${MOCK_FAIL_FINANCIAL_DRIFT:-0}" = 1 ] && [ "$count" -gt 1 ]; then digest=changed; fi
      printf 'MIHU_JSON:{"integrity":"ok","fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","fingerprints":{"users":{"rows":1,"digest":"%s"},"orders":{"rows":1,"digest":"orders"},"wallet_transactions":{"rows":1,"digest":"wallet"},"topups":{"rows":0,"digest":"topups"},"payouts":{"rows":0,"digest":"payouts"},"payout_ledger":{"rows":0,"digest":"ledger"}}}\n' "$digest"
      exit 0
    fi
    if [[ "$code" == *inspectDatabaseReadiness* ]]; then
      ready=true; [ "${MOCK_SCHEMA_READY:-1}" = 1 ] || ready=false
      clean=true; [ "${MOCK_CLEAN_SALARY_STATE:-1}" = 1 ] || clean=false
      printf 'MIHU_JSON:{"ready":%s,"missing":[],"cleanSalaryState":%s,"salaryCounts":{"salary_rules":0,"salary_adjustments":0,"salary_batches":0,"salary_import_previews":0,"salary_import_batches":0,"salary_manual_previews":0,"salary_scheduler_runs":0}}\n' "$ready" "$clean"
      [ "$ready" = true ]; exit $?
    fi
    if [[ "$code" == *SERVICE_ACCESS_CHECK_V1* ]]; then echo 'MIHU_JSON:{"marker":"SERVICE_ACCESS_CHECK_V1","serviceAccess":"PASS","checkedFiles":12}'; exit 0; fi
    if [[ "$code" == *createDatabaseBackup* ]]; then
      mkdir -p "$DATABASE_BACKUP_DIR"
      printf 'mock-sqlite-backup' > "$DATABASE_BACKUP_DIR/mihu-database-mock.sqlite"
      printf '{"contractVersion":1,"backupFile":"mihu-database-mock.sqlite","integrity":"ok"}\n' > "$DATABASE_BACKUP_DIR/mihu-database-mock.sqlite.manifest.json"
      echo 'MIHU_JSON:{"backupFile":"mihu-database-mock.sqlite","manifestFile":"mihu-database-mock.sqlite.manifest.json","integrity":"ok","backupPurpose":"local-transfer-staging-only"}'
      exit 0
    fi
  fi
  if [[ " ${cmd[*]} " == *prepareFinancialBackupTransfer.js* ]]; then
    output_dir=""; backup_file=""
    for ((index=0; index<${#cmd[@]}; index++)); do
      [ "${cmd[$index]}" != --output-dir ] || output_dir="${cmd[$((index+1))]}"
      [ "${cmd[$index]}" != --backup-file ] || backup_file="${cmd[$((index+1))]}"
    done
    mkdir -p "$output_dir/mirrors"
    cp "$DATABASE_BACKUP_DIR/$backup_file" "$output_dir/database.sqlite"
    printf '{"contractVersion":1,"backupFile":"database.sqlite","integrity":"ok"}\n' > "$output_dir/database.manifest.json"
    printf '{"files":[]}\n' > "$output_dir/transfer-manifest.json"
    printf '{"mockReceipt":true}\n' > "$output_dir/receipt.json"
    exit 0
  fi
  if [[ " ${cmd[*]} " == *verifyFinancialBackupReceipt.js* ]]; then
    [ "${MOCK_FAIL_RECEIPT:-0}" != 1 ] || exit 1
    echo 'MIHU_JSON:{"status":"TRANSFER_RECEIPT_VERIFIED"}'; exit 0
  fi
  if [[ " ${cmd[*]} " == *migrateDatabase.js* ]]; then
    [ "${MOCK_FAIL_MIGRATION:-0}" != 1 ] || exit 1
    : > "$MOCK_STATE_DIR/migrated"
    echo 'MIGRATION_AND_READINESS_PASS'; exit 0
  fi
fi
exit 1
MOCK

  cat > "$bin/sudo" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
cmd="${1:-}"; shift || true
case "$cmd" in
  -u) shift; exec "$@" ;;
  systemd-run|systemctl|lsof|fuser) exec "$cmd" "$@" ;;
  install)
    while [ "$#" -gt 0 ]; do
      case "$1" in -d|-o|-g|-m) shift; [ "$#" -eq 0 ] || shift ;; *) mkdir -p "$1"; shift ;; esac
    done
    ;;
  chown|chgrp) exit 0 ;;
  chmod) exec chmod "$@" ;;
  *) exec "$cmd" "$@" ;;
esac
MOCK

  cat > "$bin/systemd-run-unused" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
cmd=(); workdir="$MOCK_APP_DIR"; envfiles=(); overrides=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --quiet|--wait|--pipe|--collect|--service-type=exec|--uid=*|--gid=*) shift ;;
    --setenv=*) overrides+=("${1#--setenv=}"); shift ;;
    -p)
      property="${2:-}"; shift 2
      case "$property" in
        WorkingDirectory=*) workdir="${property#WorkingDirectory=}" ;;
        EnvironmentFile=*) envfiles+=("${property#EnvironmentFile=}") ;;
        Environment=*) overrides+=("${property#Environment=}") ;;
      esac
      ;;
    *) cmd=("$@"); break ;;
  esac
done
for envfile in "${envfiles[@]}"; do set -a; . "$envfile"; set +a; done
for item in "${overrides[@]}"; do export "$item"; done
cd "$workdir"
program="${cmd[0]:-}"
if [[ "$program" == *npm ]]; then
  if [ "${cmd[1]:-}" = ci ]; then
    count="$(cat "$MOCK_STATE_DIR/npm-ci-count")"; count=$((count + 1)); printf '%s\n' "$count" > "$MOCK_STATE_DIR/npm-ci-count"
    if [ "${MOCK_FAIL_NPM_FIRST:-0}" = 1 ] && [ "$count" -eq 1 ]; then exit 1; fi
    exit 0
  fi
  if [ "${cmd[1]:-}" = run ] && [ "${cmd[2]:-}" = db:readiness ]; then
    count="$(cat "$MOCK_STATE_DIR/readiness-count")"; count=$((count + 1)); printf '%s\n' "$count" > "$MOCK_STATE_DIR/readiness-count"
    if [ "${MOCK_FAIL_READINESS_FIRST:-0}" = 1 ] && [ "$count" -eq 1 ]; then exit 1; fi
    exit 0
  fi
fi
if [[ "$program" == *node || "$program" == node ]]; then
  if [ "${cmd[1]:-}" = -p ] && [ "${cmd[2]:-}" = process.version ]; then echo v24.21.0; exit 0; fi
  if [ "${cmd[1]:-}" = -e ]; then
    code="${cmd[2]:-}"
    if [[ "$code" == *SALARY_SCHEDULER_ENABLED* ]]; then
      printf 'MIHU_JSON:{"role":"%s","enabled":"%s"}\n' "${MIHU_RUNTIME_ROLE:-}" "${SALARY_SCHEDULER_ENABLED:-}"
      exit 0
    fi
    if [[ "$code" == *process.env.MIHU_RUNTIME_ROLE* ]]; then printf 'MIHU_JSON:{"role":"%s"}\n' "${MIHU_RUNTIME_ROLE:-}"; exit 0; fi
  fi
  if [ "${cmd[1]:-}" = - ]; then
    code="$(cat)"
    if [[ "$code" == *databasePath:cfg.databasePath* ]]; then
      printf 'MIHU_JSON:{"databasePath":"%s","dataDir":"%s","backupDir":"%s","port":"%s"}\n' "$DATABASE_PATH" "$PRODUCTION_DATA_DIR" "$DATABASE_BACKUP_DIR" "$PORT"
      exit 0
    fi
    if [[ "$code" == *const\ tableSpecs* ]]; then
      count="$(cat "$MOCK_STATE_DIR/fingerprint-count")"; count=$((count + 1)); printf '%s\n' "$count" > "$MOCK_STATE_DIR/fingerprint-count"
      digest=same
      if [ "${MOCK_FAIL_FINANCIAL_DRIFT:-0}" = 1 ] && [ "$count" -gt 1 ]; then digest=changed; fi
      printf 'MIHU_JSON:{"integrity":"ok","fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","fingerprints":{"users":{"rows":1,"digest":"%s"},"orders":{"rows":1,"digest":"orders"},"wallet_transactions":{"rows":1,"digest":"wallet"},"topups":{"rows":0,"digest":"topups"},"payouts":{"rows":0,"digest":"payouts"},"payout_ledger":{"rows":0,"digest":"ledger"}}}\n' "$digest"
      exit 0
    fi
    if [[ "$code" == *inspectDatabaseReadiness* ]]; then
      ready=true; [ "${MOCK_SCHEMA_READY:-1}" = 1 ] || ready=false
      printf 'MIHU_JSON:{"ready":%s,"missing":[]}\n' "$ready"
      [ "$ready" = true ]
      exit $?
    fi
    if [[ "$code" == *SERVICE_ACCESS_CHECK_V1* ]]; then printf 'MIHU_JSON:{"marker":"SERVICE_ACCESS_CHECK_V1","serviceAccess":"PASS","checkedFiles":12}\n'; exit 0; fi
    if [[ "$code" == *createDatabaseBackup* ]]; then
      mkdir -p "$DATABASE_BACKUP_DIR"
      : > "$DATABASE_BACKUP_DIR/mihu-database-mock.sqlite"
      printf '{"contractVersion":1,"backupFile":"mihu-database-mock.sqlite","integrity":"ok"}\n' > "$DATABASE_BACKUP_DIR/mihu-database-mock.sqlite.manifest.json"
      printf 'MIHU_JSON:{"backupFile":"mihu-database-mock.sqlite","manifestFile":"mihu-database-mock.sqlite.manifest.json","integrity":"ok","backupPurpose":"local-transfer-staging-only"}\n'
      exit 0
    fi
  fi
  if [[ " ${cmd[*]} " == *prepareFinancialBackupTransfer.js* ]]; then
    output_dir=""; backup_file=""
    for ((i=0;i<${#cmd[@]};i++)); do
      [ "${cmd[$i]}" != --output-dir ] || output_dir="${cmd[$((i+1))]}"
      [ "${cmd[$i]}" != --backup-file ] || backup_file="${cmd[$((i+1))]}"
    done
    mkdir -p "$output_dir/mirrors"
    cp "$DATABASE_BACKUP_DIR/$backup_file" "$output_dir/database.sqlite"
    printf '{"contractVersion":1,"backupFile":"database.sqlite","integrity":"ok"}\n' > "$output_dir/database.manifest.json"
    printf '{"files":[]}\n' > "$output_dir/transfer-manifest.json"
    printf '{"mockReceipt":true}\n' > "$output_dir/receipt.json"
    exit 0
  fi
  if [[ " ${cmd[*]} " == *verifyFinancialBackupReceipt.js* ]]; then
    [ "${MOCK_FAIL_RECEIPT:-0}" != 1 ] || exit 1
    echo 'MIHU_JSON:{"status":"TRANSFER_RECEIPT_VERIFIED"}'
    exit 0
  fi
  if [[ " ${cmd[*]} " == *migrateDatabase.js* ]]; then
    [ "${MOCK_FAIL_MIGRATION:-0}" != 1 ] || exit 1
    : > "$MOCK_STATE_DIR/migrated"
    echo 'MIGRATION_AND_READINESS_PASS'
    exit 0
  fi
fi
exit 1
MOCK

  cat > "$bin/git" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
if [ "${1:-}" = --no-pager ]; then shift; fi
cmd="${1:-}"; shift || true
case "$cmd" in
  status) exit 0 ;;
  rev-parse)
    if [ "${1:-}" = --is-inside-work-tree ]; then echo true; exit 0; fi
    if [ "${1:-}" = --verify ] && [ "${2:-}" = HEAD ]; then cat "$MOCK_STATE_DIR/head"; exit 0; fi
    ;;
  fetch|cat-file) exit 0 ;;
  merge-base)
    [ "${1:-}" = --is-ancestor ] || exit 1
    first="${2:-}"; second="${3:-}"
    count=0; [ ! -f "$MOCK_STATE_DIR/merge-base-count" ] || count="$(cat "$MOCK_STATE_DIR/merge-base-count")"
    count=$((count+1)); printf '%s\n' "$count" > "$MOCK_STATE_DIR/merge-base-count"
    printf 'first=%s second=%s staging=%s mock=%s\n' "$first" "$second" "${BACKUP_STAGING_COMMIT:-}" "${MOCK_STAGING_RELEASE:-}" >> "$MOCK_STATE_DIR/merge-base.log"
    if [ "$count" -eq 1 ] && [ "$first" = "$TARGET_COMMIT" ] && [ "$second" = origin/main ]; then exit 0; fi
    if [ "$count" -eq 2 ] && [ "$first" = "${BACKUP_STAGING_COMMIT:-$MOCK_STAGING_RELEASE}" ] && [ "$second" = "$TARGET_COMMIT" ] && [ "$first" = "$MOCK_STAGING_RELEASE" ]; then exit 0; fi
    if [ "$count" -eq 3 ] && [ "$first" = "$EXPECTED_PREVIOUS_COMMIT" ] && [ "$second" = "$TARGET_COMMIT" ]; then exit 0; fi
    exit 1
    ;;
  diff)
    [ "${1:-}" != --name-only ] || { printf '%s\n' database.js utils/salarySchema.js utils/databaseReadiness.js services/payoutService.js services/salaryScheduler.js package-lock.json package.json; exit 0; }
    echo 'mock salary diff'
    exit 0
    ;;
  checkout)
    [ "${1:-}" = --detach ] || exit 1
    printf '%s\n' "${2:?}" > "$MOCK_STATE_DIR/head"
    exit 0
    ;;
  show)
    case "${1:-}" in
      *:package.json) cat "$MOCK_APP_DIR/package.json" ;;
      *:package-lock.json) cat "$MOCK_APP_DIR/package-lock.json" ;;
      *) exit 1 ;;
    esac
    exit 0
    ;;
  archive)
    [ "${1:-}" = "$MOCK_STAGING_RELEASE" ] || exit 1
    shift
    tar -C "$MOCK_APP_DIR" -cf - "$@"
    exit 0
    ;;
esac
exit 1
MOCK

  cat > "$bin/systemctl" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
cmd="${1:-}"; shift || true
case "$cmd" in
  cat) exit 0 ;;
  show)
    key="${2:-}"; service="${4:-${3:-}}"
    case "$key" in
      User|Group) echo mihu ;;
      WorkingDirectory) echo "$MOCK_APP_DIR" ;;
      ExecStart) [ "$service" = mihu-web.service ] && echo '/usr/bin/npm start' || echo '/usr/bin/node botRunner.js' ;;
      EnvironmentFiles) [ "$service" = mihu-web.service ] && echo "$MOCK_COMMON_ENV $MOCK_WEB_ENV" || echo "$MOCK_COMMON_ENV $MOCK_BOT_ENV" ;;
      *) exit 1 ;;
    esac
    ;;
  is-active)
    quiet=0; [ "${1:-}" != --quiet ] || { quiet=1; shift; }
    state="$(cat "$MOCK_STATE_DIR/${1:?}")"
    [ "$state" = active ] && { [ "$quiet" -eq 1 ] || echo active; exit 0; }
    [ "$quiet" -eq 1 ] || echo inactive
    exit 3
    ;;
  stop|start)
    value=inactive; [ "$cmd" != start ] || value=active
    for service in "$@"; do printf '%s\n' "$value" > "$MOCK_STATE_DIR/$service"; done
    ;;
  *) exit 1 ;;
esac
MOCK

  cat > "$bin/sudo" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
cmd="${1:-}"; shift || true
case "$cmd" in
  -u) shift; exec "$@" ;;
  systemd-run|systemctl|lsof|fuser) exec "$cmd" "$@" ;;
  install)
    while [ "$#" -gt 0 ]; do
      case "$1" in -d|-o|-g|-m) shift; [ "$#" -eq 0 ] || shift ;; *) mkdir -p "$1"; shift ;; esac
    done
    ;;
  chown|chgrp) exit 0 ;;
  chmod) exec chmod "$@" ;;
  *) exec "$cmd" "$@" ;;
esac
MOCK

  cat > "$bin/lsof" <<'MOCK'
#!/usr/bin/env bash
exit 0
MOCK
  cat > "$bin/npm" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
if [ "${1:-}" = ci ]; then
  count="$(cat "$MOCK_STATE_DIR/npm-ci-count")"; count=$((count+1)); printf '%s\n' "$count" > "$MOCK_STATE_DIR/npm-ci-count"
  if [ "${MOCK_FAIL_NPM_FIRST:-0}" = 1 ] && [ "$count" -eq 1 ]; then exit 1; fi
  exit 0
fi
if [ "${1:-}" = run ] && [ "${2:-}" = db:readiness ]; then
  count="$(cat "$MOCK_STATE_DIR/readiness-count")"; count=$((count+1)); printf '%s\n' "$count" > "$MOCK_STATE_DIR/readiness-count"
  if [ "${MOCK_FAIL_READINESS_FIRST:-0}" = 1 ] && [ "$count" -eq 1 ]; then exit 1; fi
  exit 0
fi
if [ "${1:-}" = run ] && [ "${2:-}" = db:preflight ]; then
  [ "${MOCK_FAIL_PREFLIGHT:-0}" != 1 ] || exit 1
  printf '{"status":"PASS","mode":"INITIALIZATION"}\n'
  exit 0
fi
exit 1
MOCK

  cat > "$bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '200'
MOCK

  chmod +x "$bin"/*
}

run_case() {
  local name="$1" expected_rc="$2" expected_web="$3" expected_bot="$4" initial_bot=active
  if [ "$#" -ge 5 ] && { [ "$5" = active ] || [ "$5" = inactive ]; }; then initial_bot="$5"; shift 5; else shift 4; fi
  local -a mock_overrides=("$@")
  local preflight_status=PASS preflight_response=YES deployment_flow=UPDATE preflight_mode='' override
  for override in "${mock_overrides[@]}"; do
    case "$override" in
      MOCK_PREFLIGHT_STATUS=*) preflight_status="${override#*=}" ;;
      MOCK_PREFLIGHT_RESPONSE=*) preflight_response="${override#*=}" ;;
      DEPLOYMENT_FLOW=*) deployment_flow="${override#*=}" ;;
      PREFLIGHT_MODE=*) preflight_mode="${override#*=}" ;;
    esac
  done
  local root
  root="$(mktemp -d "${TMPDIR:-/tmp}/salary-deploy-mock.XXXXXX")"
  make_mock "$root"
  local app="$root/app" state="$root/state" envdir="$root/env" bin="$root/bin" db="$root/prod.sqlite"
  : > "$db"
  mkdir -p "$root/data" "$root/backups"
  printf '[]\n' > "$root/data/users.json"
  printf '[]\n' > "$root/data/orders.json"
  printf '[]\n' > "$root/data/topups.json"
  printf '[]\n' > "$root/data/payouts.json"
  cat > "$envdir/common.env" <<EOF
NODE_ENV=production
APP_ENV=production
DATABASE_PATH=$db
PRODUCTION_DATA_DIR=$root/data
DATABASE_BACKUP_DIR=$root/backups
PORT=3210
MIHU_RUNTIME_ROLE=web
EOF
  cat > "$envdir/web.env" <<'EOF'
MIHU_RUNTIME_ROLE=web
SALARY_SCHEDULER_ENABLED=false
EOF
  cat > "$envdir/bot.env" <<'EOF'
MIHU_RUNTIME_ROLE=bot
EOF
  printf '%s\n' "$PREVIOUS" > "$state/head"
  printf 'active\n' > "$state/mihu-web.service"
  printf '%s\n' "$initial_bot" > "$state/mihu-bot.service"
  printf '0\n' > "$state/fingerprint-count"
  printf '0\n' > "$state/npm-ci-count"
  printf '0\n' > "$state/readiness-count"

  set +e
  local -a deploy_command=(bash "$DEPLOY_SCRIPT")
  [ "${MOCK_TRACE:-0}" != 1 ] || deploy_command=(bash -x "$DEPLOY_SCRIPT")
  local input=$'YES\nYES\nYES\n'
  if [ "$preflight_status" = ACTION_REQUIRED ] && [ "$deployment_flow" != GO_LIVE ]; then input+="$preflight_response"$'\n'; fi
  input+=$'TRANSFER_READY\nMIGRATE_SALARY_SCHEMA\n'
  printf '%s' "$input" | \
    PATH="$bin:$PATH" APP_DIR="$app" MOCK_APP_DIR="$app" MOCK_STATE_DIR="$state" \
    MOCK_COMMON_ENV="$envdir/common.env" MOCK_WEB_ENV="$envdir/web.env" MOCK_BOT_ENV="$envdir/bot.env" \
    TARGET_COMMIT="$TARGET" EXPECTED_PREVIOUS_COMMIT="$PREVIOUS" EXPECTED_DATABASE_PATH="$db" \
    MOCK_STAGING_RELEASE="$STAGING_RELEASE" \
    NODE_BIN="node" NPM_BIN="$bin/npm" STATE_DIR="$root/deploy-state" TRANSFER_PARENT="$root/transfers" \
    WINDOWS_BACKUP_ROOT='D:/mihu-bot-mimi/backups' \
    DEPLOYMENT_FLOW="$deployment_flow" PREFLIGHT_MODE="$preflight_mode" \
    env "${mock_overrides[@]}" "${deploy_command[@]}" > "$root/$name.log" 2>&1
  local rc=$?
  set -e
  local web bot
  web="$(cat "$state/mihu-web.service")"; bot="$(cat "$state/mihu-bot.service")"
  printf 'MOCK_CASE=%s exit=%s web=%s bot=%s\n' "$name" "$rc" "$web" "$bot"
  [ "$rc" -eq "$expected_rc" ] || { cat "$root/$name.log"; return 1; }
  [ "$web" = "$expected_web" ] && [ "$bot" = "$expected_bot" ] || { cat "$root/$name.log"; return 1; }
  case "$name" in
    success|success-preserve-inactive-bot)
      grep -q 'SALARY_DEPLOYMENT_SUCCESS' "$root/$name.log"
      grep -q 'Windows receipt upload destination=' "$root/$name.log"
      grep -q 'scheduler remains disabled' "$root/$name.log"
      grep -Fxq "EnvironmentFile=$envdir/common.env" "$state/environment-properties.log"
      grep -Fxq "EnvironmentFile=$envdir/web.env" "$state/environment-properties.log"
      grep -Fxq "EnvironmentFile=$envdir/bot.env" "$state/environment-properties.log"
      ! grep -Fq "EnvironmentFile=$envdir/common.env $envdir/web.env" "$state/environment-properties.log"
      ;;
    success-noisy-backup-output)
      grep -q 'SALARY_DEPLOYMENT_SUCCESS' "$root/$name.log"
      grep -q 'backup-helper-finished' "$root/$name.log"
      ;;
    backup-staging-purpose-missing|backup-staging-purpose-external)
      grep -q 'Backup manifest does not identify local-transfer-staging-only mode' "$root/$name.log"
      grep -q 'pre-migration recovery complete' "$root/$name.log"
      grep -q 'backup_manifest=' "$root/$name.log"
      ! grep -q 'backup_manifest=not-created' "$root/$name.log"
      ;;
    pre-migration-failure)
      grep -q 'failure before migration; restore rollback code=' "$root/$name.log"
      grep -q 'pre-migration recovery complete' "$root/$name.log"
      ;;
    governance-action-required-confirmed)
      grep -q 'governance-only ACTION_REQUIRED interactively confirmed' "$root/$name.log"
      ;;
    governance-action-required-unconfirmed)
      grep -q 'governance-only UPDATE was not interactively confirmed' "$root/$name.log"
      grep -q 'failure before writer freeze; services unchanged' "$root/$name.log"
      ;;
    preflight-structural-failure|preflight-unknown-check|preflight-unknown-governance-value)
      grep -q 'ACTION_REQUIRED contains structural, unknown or unrecognized blockers' "$root/$name.log"
      grep -q 'failure before writer freeze; services unchanged' "$root/$name.log"
      ;;
    go-live-action-required)
      grep -q 'GO_LIVE requires strict preflight PASS' "$root/$name.log"
      grep -q 'failure before writer freeze; services unchanged' "$root/$name.log"
      ;;
    unrecognized-preflight)
      grep -q 'preflight INITIALIZATION returned unrecognized status' "$root/$name.log"
      grep -q 'failure before writer freeze; services unchanged' "$root/$name.log"
      ;;
    target-missing-staging-contract)
      grep -q 'target release does not contain required local backup staging contract' "$root/$name.log"
      grep -q 'failure before writer freeze; services unchanged' "$root/$name.log"
      ;;
    receipt-incomplete)
      [ ! -f "$state/migrated" ]
      grep -q 'pre-migration recovery complete' "$root/$name.log"
      ;;
    post-migration-incompatible)
      grep -q 'migration attempted; no automatic DB restore and no blind code rollback' "$root/$name.log"
      grep -q 'post-migration compatibility not proven' "$root/$name.log"
      ! grep -q 'restoring database\|restoreProductionDatabase' "$root/$name.log"
      ;;
    post-migration-compatible-recovery)
      grep -q 'post-migration compatibility verified' "$root/$name.log"
      grep -q 'compatible target services restored' "$root/$name.log"
      ;;
  esac
  rm -rf "$root"
}

run_case success 0 active active
run_case success-preserve-inactive-bot 0 active inactive inactive
run_case success-noisy-backup-output 0 active active MOCK_BACKUP_OUTPUT_NOISE=1
run_case backup-staging-purpose-missing 1 active active MOCK_BACKUP_PURPOSE_MODE=missing
run_case backup-staging-purpose-external 1 active active MOCK_BACKUP_PURPOSE_MODE=external
run_case governance-action-required-confirmed 0 active active MOCK_PREFLIGHT_STATUS=ACTION_REQUIRED
run_case governance-action-required-unconfirmed 1 active active MOCK_PREFLIGHT_STATUS=ACTION_REQUIRED MOCK_PREFLIGHT_RESPONSE=NO
run_case preflight-structural-failure 1 active active MOCK_PREFLIGHT_STATUS=ACTION_REQUIRED MOCK_PREFLIGHT_SCHEMA_FAIL=1
run_case preflight-unknown-check 1 active active MOCK_PREFLIGHT_STATUS=ACTION_REQUIRED MOCK_PREFLIGHT_UNKNOWN_CHECK=1
run_case preflight-unknown-governance-value 1 active active MOCK_PREFLIGHT_STATUS=ACTION_REQUIRED MOCK_PREFLIGHT_UNKNOWN_GOVERNANCE_VALUE=1
run_case go-live-action-required 1 active active MOCK_PREFLIGHT_STATUS=ACTION_REQUIRED DEPLOYMENT_FLOW=GO_LIVE
run_case unrecognized-preflight 1 active active MOCK_PREFLIGHT_STATUS=UNKNOWN
run_case target-missing-staging-contract 1 active active BACKUP_STAGING_COMMIT=ad52aad2b3bb26ab28c0fafd0f6ad9b3eadf7a13
run_case receipt-incomplete 1 active active MOCK_FAIL_RECEIPT=1
run_case pre-migration-failure 1 active active MOCK_FAIL_NPM_FIRST=1
run_case post-migration-incompatible 1 inactive inactive MOCK_FAIL_MIGRATION=1 MOCK_SCHEMA_READY=0
run_case post-migration-compatible-recovery 1 active active MOCK_FAIL_READINESS_FIRST=1

echo SALARY_DEPLOY_MOCK_VALIDATION_PASS
