#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

TARGET_COMMIT="${TARGET_COMMIT:-cf870e1e0de6f69d49520ebbb589e3a0ead4b4a4}"
BACKUP_STAGING_COMMIT="${BACKUP_STAGING_COMMIT:-cf870e1e0de6f69d49520ebbb589e3a0ead4b4a4}"
EXPECTED_PREVIOUS_COMMIT="${EXPECTED_PREVIOUS_COMMIT:-ad52aad2b3bb26ab28c0fafd0f6ad9b3eadf7a13}"
DEPLOYMENT_FLOW="${DEPLOYMENT_FLOW:-UPDATE}"
PREFLIGHT_MODE="${PREFLIGHT_MODE:-}"
APP_DIR="${APP_DIR:-/opt/mihu/app}"
WEB_SERVICE="${WEB_SERVICE:-mihu-web.service}"
BOT_SERVICE="${BOT_SERVICE:-mihu-bot.service}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
NPM_BIN="${NPM_BIN:-/usr/bin/npm}"
EXPECTED_DATABASE_PATH="${EXPECTED_DATABASE_PATH:-/var/lib/mihu/database.sqlite}"
WINDOWS_BACKUP_ROOT="${WINDOWS_BACKUP_ROOT:-D:/mihu-bot-mimi/backups}"
SCP_TARGET="${SCP_TARGET:-deploy@172.237.72.87}"
TRANSFER_PARENT="${TRANSFER_PARENT:-/var/tmp}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

STAGE=init
STATE_DIR="${STATE_DIR:-/var/tmp/mihu-salary-deploy-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
mkdir -m 700 -p "$STATE_DIR"
BASELINE_FILE="$STATE_DIR/baseline.json"
POST_FILE="$STATE_DIR/post.json"

PRE_HEAD=""
DATABASE_PATH=""
DATABASE_BACKUP_DIR=""
PRODUCTION_DATA_DIR=""
WEB_PORT=""
TRANSFER_ID=""
TRANSFER_ROOT=""
TRANSFER_RECEIPT=""
BACKUP_TOOL_DIR=""
BACKUP_FILE_PATH=""
BACKUP_MANIFEST_PATH=""

WEB_USER=""
WEB_GROUP=""
WEB_WORKDIR=""
WEB_ENVFILES=()
WEB_WAS_ACTIVE=0
BOT_USER=""
BOT_GROUP=""
BOT_WORKDIR=""
BOT_ENVFILES=()
BOT_WAS_ACTIVE=0
SERVICE_STATE_CAPTURED=0
DOWNTIME_STARTED=0
CODE_UPDATED=0
DEPENDENCIES_CHANGED=0
MIGRATION_ATTEMPTED=0
MIGRATION_COMPLETED=0
POST_MIGRATION_VALIDATED=0

log() { printf '[%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"; }
fail() { log "FATAL: $*"; return 1; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"; }

extract_json_marker() {
  printf '%s\n' "$1" | sed -n 's/^MIHU_JSON://p' | tail -n1
}

json_get() {
  "$NODE_BIN" -e '
const root = JSON.parse(process.argv[1]);
let value = root;
for (const part of String(process.argv[2] || "").split(".").filter(Boolean)) {
  value = value && Object.prototype.hasOwnProperty.call(value, part) ? value[part] : "";
}
process.stdout.write(value === undefined || value === null ? "" : String(value));
' "$1" "$2"
}

parse_unit_context() {
  local service="$1" prefix="$2" user group workdir exec_start env_raw token optional path
  systemctl cat "$service" >/dev/null || fail "systemd unit not found: $service"
  user="$(systemctl show -p User --value "$service")"
  group="$(systemctl show -p Group --value "$service")"
  workdir="$(systemctl show -p WorkingDirectory --value "$service")"
  exec_start="$(systemctl show -p ExecStart --value "$service")"
  env_raw="$(systemctl show -p EnvironmentFiles --value "$service")"
  [ -n "$user" ] || fail "$service has no User"
  [ -n "$group" ] || group="$user"
  [ "$user" = mihu ] || fail "$service must run as mihu (actual: $user)"
  [ "$group" = mihu ] || fail "$service must run as group mihu (actual: $group)"
  [ "$workdir" = "$APP_DIR" ] || fail "$service WorkingDirectory differs from $APP_DIR"
  [ -n "$exec_start" ] || fail "$service has no ExecStart"
  [ -n "$env_raw" ] || fail "$service has no EnvironmentFile entries"

  if [ "$prefix" = WEB ]; then
    WEB_USER="$user"; WEB_GROUP="$group"; WEB_WORKDIR="$workdir"
  else
    BOT_USER="$user"; BOT_GROUP="$group"; BOT_WORKDIR="$workdir"
  fi
  local -a envfiles=()
  while IFS= read -r token; do
    [[ "$token" == /* || "$token" == -*/* ]] || continue
    optional=0
    path="$token"
    if [[ "$path" == -* ]]; then optional=1; path="${path#-}"; fi
    if [ ! -f "$path" ]; then
      [ "$optional" -eq 1 ] && continue
      fail "$service EnvironmentFile missing: $path"
    fi
    envfiles+=("$token")
  done < <(printf '%s\n' "$env_raw" | tr ' ' '\n')
  [ "${#envfiles[@]}" -gt 0 ] || fail "$service EnvironmentFile list could not be parsed"
  if [ "$prefix" = WEB ]; then WEB_ENVFILES=("${envfiles[@]}"); else BOT_ENVFILES=("${envfiles[@]}"); fi
  log "$service user=$user group=$group workdir=$workdir"
  for token in "${envfiles[@]}"; do log "$service EnvironmentFile=$token"; done
}

run_unit() {
  local prefix="$1"; shift
  local user group workdir
  local -a envfiles=() cmd overrides=()
  if [ "$prefix" = WEB ]; then
    user="$WEB_USER"; group="$WEB_GROUP"; workdir="$WEB_WORKDIR"; envfiles=("${WEB_ENVFILES[@]}")
  else
    user="$BOT_USER"; group="$BOT_GROUP"; workdir="$BOT_WORKDIR"; envfiles=("${BOT_ENVFILES[@]}")
  fi
  while [ "$#" -gt 0 ] && [[ "$1" == --setenv=* ]]; do
    overrides+=("${1#--setenv=}")
    shift
  done
  cmd=(sudo systemd-run --quiet --wait --pipe --collect --service-type=exec --uid="$user" --gid="$group" -p "WorkingDirectory=$workdir" -p "Environment=PATH=/usr/bin:/bin")
  local item
  for item in "${envfiles[@]}"; do cmd+=(-p "EnvironmentFile=$item"); done
  for item in "${overrides[@]}"; do cmd+=("--setenv=$item"); done
  cmd+=("$@")
  "${cmd[@]}"
}

run_with_code_umask() {
  local prior
  prior="$(umask)"
  umask 022
  "$@"
  local result=$?
  umask "$prior"
  return "$result"
}

service_is_active() { systemctl is-active --quiet "$1"; }

stop_all_writers() {
  DOWNTIME_STARTED=1
  sudo systemctl stop "$WEB_SERVICE" "$BOT_SERVICE"
  if service_is_active "$WEB_SERVICE"; then fail "$WEB_SERVICE remains active after stop"; fi
  if service_is_active "$BOT_SERVICE"; then fail "$BOT_SERVICE remains active after stop"; fi
  local handles=""
  if command -v lsof >/dev/null 2>&1; then
    handles="$(sudo lsof -t -- "$DATABASE_PATH" 2>/dev/null || true)"
  elif command -v fuser >/dev/null 2>&1; then
    handles="$(sudo fuser "$DATABASE_PATH" 2>/dev/null || true)"
  else
    fail "lsof or fuser is required to verify writers stopped"
  fi
  [ -z "$(printf '%s' "$handles" | tr -d '[:space:]')" ] || fail "database handles remain after stopping Web/Bot: $handles"
  local suffix
  for suffix in -wal -shm -journal; do [ ! -e "$DATABASE_PATH$suffix" ] || fail "SQLite sidecar remains: $DATABASE_PATH$suffix"; done
}

capture_financial_fingerprint() {
  local output json destination="$1"
  output="$(run_unit WEB \
    --setenv=PRODUCTION_IDENTITY_VERIFIED=YES \
    --setenv=PRODUCTION_STORAGE_VERIFIED=YES \
    "$NODE_BIN" - <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const sqlite3 = require('sqlite3').verbose();
const { inspectProductionDatabaseConfig } = require('./utils/productionDatabaseConfig');
function all(db, sql) { return new Promise((resolve, reject) => db.all(sql, (error, rows) => error ? reject(error) : resolve(rows || []))); }
(async () => {
  const config = inspectProductionDatabaseConfig(process.env);
  if (!config.ok) throw new Error(config.errors.join('; '));
  const db = await new Promise((resolve, reject) => {
    const handle = new sqlite3.Database(config.databasePath, sqlite3.OPEN_READONLY, error => error ? reject(error) : resolve(handle));
  });
  try {
    const integrityRows = await all(db, 'PRAGMA integrity_check');
    const tableSpecs = {
      users: 'SELECT id,role,studio_id,balance,bonus_balance,manual_spent,manual_deposited,vip_level FROM users ORDER BY id',
      orders: 'SELECT id,order_no,status,studio_id,boss_id,talent_id,total_amount,discount,commission_rate_snapshot,platform_commission,talent_earning FROM orders ORDER BY id',
      wallet_transactions: "SELECT id,user_id,type,amount,balance_before,balance_after,COALESCE(bonus_amount,0) bonus_amount,reference_type,reference_id,description,operator_id,created_at FROM wallet_transactions ORDER BY id",
      topups: 'SELECT id,user_id,amount,bonus,channel_type,note,operator_id,created_at FROM topups ORDER BY id',
      payouts: 'SELECT id,user_id,studio_id,withdrawal_period,amount,status,requested_at,paid_at FROM payouts ORDER BY id',
      payout_ledger: 'SELECT id,payout_id,withdrawal_no,user_id,studio_id,type,amount,operator_id,created_at FROM payout_ledger ORDER BY id',
      role_permissions: 'SELECT role_key,permissions FROM roles ORDER BY role_key'
    };
    const fingerprints = {};
    for (const [name, sql] of Object.entries(tableSpecs)) {
      const rows = await all(db, sql);
      const digest = crypto.createHash('sha256').update(rows.map(row => JSON.stringify(row)).join('\\n')).digest('hex');
      fingerprints[name] = { rows: rows.length, digest };
    }
    const stat = fs.statSync(config.databasePath);
    const fileSha256 = crypto.createHash('sha256').update(fs.readFileSync(config.databasePath)).digest('hex');
    const schema = { integrity: integrityRows[0]?.integrity_check || 'missing', fileSize: stat.size, fileSha256, fingerprints };
    schema.fingerprint = crypto.createHash('sha256').update(JSON.stringify(fingerprints)).digest('hex');
    console.log('MIHU_JSON:' + JSON.stringify(schema));
  } finally { await new Promise(resolve => db.close(resolve)); }
})().catch(error => { console.error(error.message); process.exit(1); });
NODE
)"
  printf '%s\n' "$output"
  json="$(extract_json_marker "$output")" || fail "fingerprint output missing"
  printf '%s\n' "$json" > "$destination"
  [ "$(json_get "$json" integrity)" = ok ] || fail "SQLite integrity check failed"
}

compare_financial_fingerprints() {
  "$NODE_BIN" - "$BASELINE_FILE" "$POST_FILE" <<'NODE'
const fs = require('node:fs');
const before = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const after = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
if (before.integrity !== 'ok' || after.integrity !== 'ok') throw new Error('integrity check failed');
for (const name of Object.keys(before.fingerprints)) {
  if (!after.fingerprints[name] || JSON.stringify(before.fingerprints[name]) !== JSON.stringify(after.fingerprints[name])) {
    throw new Error(`financial fingerprint changed: ${name}`);
  }
}
process.stdout.write(JSON.stringify({ result: 'PASS', tables: Object.keys(before.fingerprints) }));
NODE
}

read_only_salary_schema_check() {
  local output json status
  output="$(run_unit WEB \
    --setenv=PRODUCTION_IDENTITY_VERIFIED=YES \
    --setenv=PRODUCTION_STORAGE_VERIFIED=YES \
    "$NODE_BIN" - <<'NODE'
const sqlite3 = require('sqlite3').verbose();
const { inspectProductionDatabaseConfig } = require('./utils/productionDatabaseConfig');
const { inspectDatabaseReadiness } = require('./utils/databaseReadiness');
const config = inspectProductionDatabaseConfig(process.env);
if (!config.ok) throw new Error(config.errors.join('; '));
const db = new sqlite3.Database(config.databasePath, sqlite3.OPEN_READONLY, error => {
  if (error) { console.error(error.message); process.exit(1); }
  inspectDatabaseReadiness(db).then(report => db.close(closeError => {
    if (closeError) { console.error(closeError.message); process.exit(1); }
    const salary = report.missing.filter(item => item.startsWith('salary_'));
    const readonly = new sqlite3.Database(config.databasePath, sqlite3.OPEN_READONLY);
    const tableCounts = {};
    const tables = ['salary_rules','salary_adjustments','salary_batches','salary_import_previews',
      'salary_import_batches','salary_manual_previews','salary_scheduler_runs'];
    Promise.all(tables.map(table => new Promise((resolve, reject) => readonly.get(
      `SELECT COUNT(*) AS count FROM ${table}`,
      (queryError, row) => queryError ? reject(queryError) : resolve([table, Number(row && row.count || 0)])
    )))).then(entries => {
      entries.forEach(([table, count]) => { tableCounts[table] = count; });
      readonly.close(closeError => {
        if (closeError) { console.error(closeError.message); process.exit(1); }
        const cleanSalaryState = Object.values(tableCounts).every(count => count === 0);
        console.log('MIHU_JSON:' + JSON.stringify({ ready: report.ready, missing: report.missing,
          salaryMissing: salary, cleanSalaryState, salaryCounts: tableCounts }));
        if (!report.ready || salary.length || !cleanSalaryState) process.exitCode = 1;
      });
    }).catch(queryError => { readonly.close(() => {}); console.error(queryError.message); process.exit(1); });
  })).catch(problem => { console.error(problem.message); process.exit(1); });
});
NODE
)"
  printf '%s\n' "$output"
  json="$(extract_json_marker "$output")" || fail "read-only schema report missing"
  status="$(json_get "$json" ready)"
  if [ "$status" != true ]; then fail "database readiness failed"; return 1; fi
  status="$(json_get "$json" cleanSalaryState)"
  if [ "$status" != true ]; then fail "migration created salary rules, payouts or scheduler activity unexpectedly"; return 1; fi
}

assert_scheduler_disabled() {
  local output json value
  output="$(run_unit WEB "$NODE_BIN" -e 'console.log("MIHU_JSON:" + JSON.stringify({role:process.env.MIHU_RUNTIME_ROLE || "",enabled:process.env.SALARY_SCHEDULER_ENABLED || ""}))')"
  printf '%s\n' "$output"
  json="$(extract_json_marker "$output")" || fail "could not inspect Web scheduler environment"
  if [ "$(json_get "$json" role)" != web ]; then fail "Web EnvironmentFiles do not set MIHU_RUNTIME_ROLE=web"; return 1; fi
  value="$(json_get "$json" enabled)"
  if [ -n "$value" ] && [ "$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')" != false ]; then
    fail "SALARY_SCHEDULER_ENABLED must be false or unset; refusing automatic salary distribution"
    return 1
  fi
  log "scheduler disabled (SALARY_SCHEDULER_ENABLED=${value:-unset})"
}

assert_runtime_roles() {
  local web_output bot_output web_json bot_json
  web_output="$(run_unit WEB "$NODE_BIN" -e 'console.log("MIHU_JSON:" + JSON.stringify({role:process.env.MIHU_RUNTIME_ROLE || ""}))')"
  bot_output="$(run_unit BOT "$NODE_BIN" -e 'console.log("MIHU_JSON:" + JSON.stringify({role:process.env.MIHU_RUNTIME_ROLE || ""}))')"
  web_json="$(extract_json_marker "$web_output")" || fail 'could not inspect Web runtime role'
  bot_json="$(extract_json_marker "$bot_output")" || fail 'could not inspect Bot runtime role'
  if [ "$(json_get "$web_json" role)" != web ]; then fail 'Web EnvironmentFiles must set MIHU_RUNTIME_ROLE=web'; return 1; fi
  if [ "$(json_get "$bot_json" role)" != bot ]; then fail 'Bot EnvironmentFiles must set MIHU_RUNTIME_ROLE=bot'; return 1; fi
}

check_service_node24() {
  local web_version bot_version major
  web_version="$(run_unit WEB "$NODE_BIN" -p 'process.version')"
  bot_version="$(run_unit BOT "$NODE_BIN" -p 'process.version')"
  log "Web Node=${web_version}; Bot Node=${bot_version}"
  for major in "$web_version" "$bot_version"; do [[ "$major" =~ ^v24\. ]] || fail "Node 24 required under both actual service EnvironmentFiles (found $major)"; done
}

assert_no_opposite_systemd_exec() {
  local web_exec bot_exec
  web_exec="$(systemctl show -p ExecStart --value "$WEB_SERVICE")"
  bot_exec="$(systemctl show -p ExecStart --value "$BOT_SERVICE")"
  [[ "$web_exec" == *npm* ]] || fail "$WEB_SERVICE ExecStart is not the expected npm Web runtime"
  [[ "$bot_exec" == *botRunner.js* ]] || fail "$BOT_SERVICE ExecStart is not botRunner.js"
}

assert_service_access() {
  run_unit WEB "$NODE_BIN" - <<'NODE'
const fs = require('node:fs');
const marker = 'SERVICE_ACCESS_CHECK_V1';
const directories = ['.','./config','./handlers','./middleware','./routes','./services','./utils','./commands','./views','./node_modules'];
const criticalFiles = ['./index.js','./app.js','./database.js','./package.json','./package-lock.json',
  './scripts/migrateDatabase.js','./scripts/backupDatabase.js','./scripts/productionReadiness.js',
  './services/salaryScheduler.js','./services/salaryService.js','./utils/salarySchema.js'];
try {
  let checkedFiles = 0;
  for (const directory of directories) {
    if (!fs.existsSync(directory)) continue;
    fs.accessSync(directory, fs.constants.X_OK);
  }
  for (const file of criticalFiles) {
    if (!fs.existsSync(file)) throw new Error(`runtime file missing: ${file}`);
    fs.accessSync(file, fs.constants.R_OK);
    checkedFiles += 1;
  }
  for (const root of ['./config','./handlers','./middleware','./routes','./services','./utils','./commands']) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const file = `${current}/${entry.name}`;
        if (entry.isDirectory()) { fs.accessSync(file, fs.constants.X_OK); stack.push(file); }
        else if (entry.isFile() && file.endsWith('.js')) { fs.accessSync(file, fs.constants.R_OK); checkedFiles += 1; }
      }
    }
  }
  const csvParser = require.resolve('csv-parse/sync');
  fs.accessSync(csvParser, fs.constants.R_OK);
  console.log('MIHU_JSON:' + JSON.stringify({marker,serviceAccess:'PASS',checkedFiles,directories:directories.length,csvParser}));
} catch (error) { console.error(error.message); process.exit(1); }
NODE
}

run_readiness() {
  local prefix="$1"
  run_unit "$prefix" \
    --setenv=PRODUCTION_IDENTITY_VERIFIED=YES \
    --setenv=PRODUCTION_STORAGE_VERIFIED=YES \
    "$NPM_BIN" run db:readiness
}

run_read_only_preflight() {
  local mode="$1" output json status report_mode governance
  output="$(run_unit WEB \
    --setenv=PRODUCTION_IDENTITY_VERIFIED=YES \
    --setenv=PRODUCTION_STORAGE_VERIFIED=YES \
    --setenv=PRODUCTION_PREFLIGHT_CONFIRM=YES \
    --setenv=PRODUCTION_PREFLIGHT_MODE="$mode" \
    "$NODE_BIN" - <<'NODE'
const { runProductionPreflight } = require('./scripts/productionPreflight');
runProductionPreflight(process.env).then(report => {
  console.log('MIHU_JSON:' + JSON.stringify(report));
}).catch(error => { console.error(error.message); process.exit(1); });
NODE
)"
  printf '%s\n' "$output"
  json="$(extract_json_marker "$output")" || fail 'read-only preflight returned no report'
  status="$(json_get "$json" status)"
  report_mode="$(json_get "$json" mode)"
  [ "$report_mode" = "$mode" ] || fail "preflight mode mismatch: expected $mode, got ${report_mode:-missing}"
  if [ "$status" = PASS ]; then log "read-only preflight $mode: PASS"; return 0; fi
  if [ "$status" != ACTION_REQUIRED ]; then fail "preflight $mode returned unrecognized status: ${status:-missing}"; return 1; fi
  if [ "$DEPLOYMENT_FLOW" = GO_LIVE ]; then fail 'GO_LIVE requires strict preflight PASS; ACTION_REQUIRED is not bypassed'; return 1; fi

  governance="$("$NODE_BIN" - "$json" <<'NODE'
const report = JSON.parse(process.argv[2] || '{}');
const checks = report.checks || {};
const knownChecks = new Set([
  'integrity','schema','adminRole','adminAssignedUsers','adminStoredPermissionCount','adminEffectiveCapabilities',
  'breakGlassConfigured','breakGlassUserPresent','breakGlassStoredRole','resolverWildcard','wildcardRoles',
  'payoutDutyCoverage','staffing','roleAssignments','permissionJson','sqliteBusyTimeout',
  'deploymentVerified','productionRbacVerified'
]);
const unknownChecks = Object.keys(checks).filter(key => !knownChecks.has(key));
const structural = {
  integrity: checks.integrity === 'PASS',
  schema: checks.schema === 'PASS',
  adminRole: checks.adminRole === 'PRESENT',
  breakGlassConfigured: checks.breakGlassConfigured === 'CONFIGURED',
  breakGlassUserPresent: checks.breakGlassUserPresent === 'YES',
  breakGlassStoredRole: ['MEMBER','ADMIN'].includes(String(checks.breakGlassStoredRole || '')),
  resolverWildcard: checks.resolverWildcard === 'PASS',
  roleAssignments: checks.roleAssignments === 'PASS',
  permissionJson: checks.permissionJson === 'PASS',
  sqliteBusyTimeout: checks.sqliteBusyTimeout === 'PASS',
  adminCounts: Number.isInteger(checks.adminAssignedUsers) && checks.adminAssignedUsers >= 0
    && Number.isInteger(checks.adminStoredPermissionCount) && checks.adminStoredPermissionCount >= 0,
  recognizedGovernanceValues: ['PASS','FAIL'].includes(checks.wildcardRoles)
    && ['PASS','FAIL'].includes(checks.payoutDutyCoverage)
    && ['STAFFED','NOT_STAFFED'].includes(checks.staffing)
    && ['RBAC_STAFFED','NO_GO'].includes(report.goLive && report.goLive.rbac)
    && checks.deploymentVerified === false
    && checks.productionRbacVerified === false
};
const capabilityReport = checks.adminEffectiveCapabilities || {};
const expectedCapabilities = ['analytics','audit_logs','discord_control','members','orders','payroll_payout','roles','staff','system_health','system_settings'];
const capabilityKeys = Object.keys(capabilityReport).sort();
const capabilitiesValid = JSON.stringify(capabilityKeys) === JSON.stringify(expectedCapabilities)
  && expectedCapabilities.every(key => capabilityReport[key] === 'PASS');
const unknownPermissions = report.unknownPermissions || {};
const invalidPermissionSets = report.invalidPermissionSets || [];
const governanceSignals = [];
if (checks.wildcardRoles === 'FAIL') governanceSignals.push('wildcardRoles=FAIL');
if (checks.payoutDutyCoverage === 'FAIL') governanceSignals.push('payoutDutyCoverage=FAIL');
if (checks.staffing && checks.staffing !== 'STAFFED') governanceSignals.push(`staffing=${checks.staffing}`);
if (checks.breakGlassStoredRole === 'MEMBER') governanceSignals.push('breakGlassStoredRole=MEMBER');
if (report.goLive?.rbac === 'NO_GO') governanceSignals.push('goLive.rbac=NO_GO');
const allowed = report.status === 'ACTION_REQUIRED'
  && report.mode === 'INITIALIZATION'
  && Object.values(structural).every(Boolean)
  && capabilitiesValid
  && unknownChecks.length === 0
  && Object.keys(unknownPermissions).length === 0
  && invalidPermissionSets.length === 0
  && governanceSignals.length > 0;
console.log(JSON.stringify({
  allowed,
  governanceSignals,
  structuralFailures: Object.entries(structural).filter(([, valid]) => !valid).map(([key]) => key),
  capabilityKeys,
  unknownChecks,
  unknownPermissions: Object.keys(unknownPermissions),
  invalidPermissionSets
}));
NODE
)" || fail 'could not classify ACTION_REQUIRED preflight'
  printf 'Preflight ACTION_REQUIRED governance findings: %s\n' "$governance"
  [ "$(json_get "$governance" allowed)" = true ] || { fail 'ACTION_REQUIRED contains structural, unknown or unrecognized blockers'; return 1; }
  UPDATE_PREFLIGHT_ACTION_REQUIRED_CONFIRMED=""
  read -r -p 'Only recognized governance blockers remain; explicitly authorize UPDATE without changing RBAC. Type YES: ' UPDATE_PREFLIGHT_ACTION_REQUIRED_CONFIRMED
  [ "$UPDATE_PREFLIGHT_ACTION_REQUIRED_CONFIRMED" = YES ] || fail 'governance-only UPDATE was not interactively confirmed'
  log 'governance-only ACTION_REQUIRED interactively confirmed; no role/permission changes will be made'
}

restore_original_services() {
  local error=0
  if [ "$WEB_WAS_ACTIVE" -eq 1 ]; then sudo systemctl start "$WEB_SERVICE" || error=1; else sudo systemctl stop "$WEB_SERVICE" || error=1; fi
  if [ "$BOT_WAS_ACTIVE" -eq 1 ]; then sudo systemctl start "$BOT_SERVICE" || error=1; else sudo systemctl stop "$BOT_SERVICE" || error=1; fi
  if [ "$WEB_WAS_ACTIVE" -eq 1 ]; then
    local login_code health_code attempt
    for attempt in $(seq 1 30); do
      login_code="$(curl --silent --connect-timeout 2 --max-time 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${WEB_PORT}/login" || true)"
      health_code="$(curl --silent --connect-timeout 2 --max-time 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${WEB_PORT}/healthz" || true)"
      [ "$login_code" = 200 ] && [ "$health_code" = 200 ] && break
      sleep 2
    done
    [ "${login_code:-}" = 200 ] && [ "${health_code:-}" = 200 ] || error=1
  fi
  if [ "$WEB_WAS_ACTIVE" -eq 1 ]; then service_is_active "$WEB_SERVICE" || error=1; else ! service_is_active "$WEB_SERVICE" || error=1; fi
  if [ "$BOT_WAS_ACTIVE" -eq 1 ]; then service_is_active "$BOT_SERVICE" || error=1; else ! service_is_active "$BOT_SERVICE" || error=1; fi
  [ "$error" -eq 0 ] && return 0
  return 1
}

keep_services_stopped() {
  sudo systemctl stop "$WEB_SERVICE" "$BOT_SERVICE" >/dev/null 2>&1 || true
  log "FIELD_STATE web=$(systemctl is-active "$WEB_SERVICE" 2>/dev/null || true) bot=$(systemctl is-active "$BOT_SERVICE" 2>/dev/null || true) db=$DATABASE_PATH"
}

recover_after_failure() {
  local exit_code="$1"
  set +e
  if [ "$DOWNTIME_STARTED" -eq 0 ]; then
    log "failure before writer freeze; services unchanged"
    return
  fi
  if [ "$MIGRATION_ATTEMPTED" -eq 0 ]; then
    log "failure before migration; restore rollback code=$PRE_HEAD"
    if [ "$CODE_UPDATED" -eq 1 ]; then
      run_with_code_umask git checkout --detach "$PRE_HEAD" || { log 'rollback checkout failed'; keep_services_stopped; return; }
      run_with_code_umask "$NPM_BIN" ci --omit=dev || { log 'rollback dependency install failed'; keep_services_stopped; return; }
    fi
    restore_original_services || { log 'old-code service recovery failed'; keep_services_stopped; return; }
    assert_scheduler_disabled || { log 'scheduler state could not be confirmed disabled'; keep_services_stopped; return; }
    log "pre-migration recovery complete exit=$exit_code"
    return
  fi

  log "migration attempted; no automatic DB restore and no blind code rollback"
  keep_services_stopped
  if [ -f "$BASELINE_FILE" \
    ] && read_only_salary_schema_check \
    && assert_runtime_roles \
    && run_readiness WEB \
    && run_readiness BOT \
    && assert_service_access \
    && capture_financial_fingerprint "$POST_FILE" \
    && compare_financial_fingerprints; then
    log 'post-migration compatibility verified for target code and financial fingerprints'
    if restore_original_services && assert_scheduler_disabled; then
      log 'compatible target services restored to original active/inactive state'
    else
      log 'target code passed schema/data checks but service health recovery failed; stopping writers for manual inspection'
      keep_services_stopped
    fi
  else
    log 'post-migration compatibility not proven; Web/Bot remain stopped; inspect migration and verified backup manually'
    keep_services_stopped
  fi
}

on_error() {
  local exit_code=$?
  trap - ERR INT TERM
  log "DEPLOYMENT_FAILED stage=$STAGE exit=$exit_code"
  recover_after_failure "$exit_code"
  log "rollback_version=${PRE_HEAD:-unknown} backup_manifest=${BACKUP_MANIFEST_PATH:-not-created} transfer_root=${TRANSFER_ROOT:-not-created} state_dir=$STATE_DIR"
  exit "$exit_code"
}
trap on_error ERR INT TERM

for command in sudo git systemctl systemd-run "$NODE_BIN" "$NPM_BIN" curl sed grep od tr id tar; do require_cmd "$command"; done
if ! command -v lsof >/dev/null 2>&1 && ! command -v fuser >/dev/null 2>&1; then fail 'lsof or fuser is required'; fi
[ -r "$SCRIPT_DIR/verifySalaryBackupStaging.js" ] || fail 'upload verifySalaryBackupStaging.js beside this runner'
sudo -u mihu test -r "$SCRIPT_DIR/verifySalaryBackupStaging.js" || fail 'mihu cannot read the backup staging verifier beside this runner'

STAGE=enter_app_dir
[ -d "$APP_DIR" ] || fail "app directory missing: $APP_DIR"
cd "$APP_DIR"
git rev-parse --is-inside-work-tree >/dev/null || fail 'APP_DIR is not a git worktree'
[ -w .git ] && [ -w . ] || fail 'deployment identity must be able to update checkout and .git before downtime'
if [ -x scripts/testFinancialTransferPermissions.sh ]; then
  bash scripts/testFinancialTransferPermissions.sh
else
  fail 'existing financial transfer permission contract test is missing or not executable'
fi
DEPLOY_NODE_VERSION="$(node --version)"
[[ "$DEPLOY_NODE_VERSION" =~ ^v24\. ]] || fail "deployment shell must use Node 24 (found $DEPLOY_NODE_VERSION)"
log "deployment_user=$(id -un) deployment_node=$DEPLOY_NODE_VERSION"
[ -z "$(git status --porcelain --untracked-files=no)" ] || { git status --short; fail 'tracked working tree is dirty'; }
PRE_HEAD="$(git rev-parse --verify HEAD)"
[ "$PRE_HEAD" = "$EXPECTED_PREVIOUS_COMMIT" ] || fail "rollback version mismatch: expected $EXPECTED_PREVIOUS_COMMIT, found $PRE_HEAD"
log "rollback_version=$PRE_HEAD target=$TARGET_COMMIT"

git fetch origin main
git cat-file -e "${TARGET_COMMIT}^{commit}"
git cat-file -e "${BACKUP_STAGING_COMMIT}^{commit}"
git merge-base --is-ancestor "$TARGET_COMMIT" origin/main || fail 'target is not merged into origin/main'
git merge-base --is-ancestor "$BACKUP_STAGING_COMMIT" "$TARGET_COMMIT" || fail 'target release does not contain required local backup staging contract'
git merge-base --is-ancestor "$PRE_HEAD" "$TARGET_COMMIT" || fail 'current release is not an ancestor of target'
log 'target changes:'
git --no-pager diff --stat "$PRE_HEAD" "$TARGET_COMMIT"
for required in database.js utils/salarySchema.js utils/databaseReadiness.js services/payoutService.js services/salaryScheduler.js package-lock.json; do
  git diff --name-only "$PRE_HEAD" "$TARGET_COMMIT" | grep -Fxq "$required" || fail "target diff missing expected salary deployment change: $required"
done
if git diff --name-only "$PRE_HEAD" "$TARGET_COMMIT" | grep -Eq '(^|/)package\.json$|(^|/)package-lock\.json$|(^|/)npm-shrinkwrap\.json$'; then DEPENDENCIES_CHANGED=1; fi
  STAGE=verify_target_dependency_and_schema_delta
  log "dependency and salary-schema diff ($PRE_HEAD..$TARGET_COMMIT):"
  git --no-pager diff --stat "$PRE_HEAD" "$TARGET_COMMIT" -- package.json package-lock.json database.js utils/salarySchema.js utils/databaseReadiness.js services/payoutService.js
  TARGET_PACKAGE_INFO="$(git show "$TARGET_COMMIT:package.json" | "$NODE_BIN" -e '
  let input="";
  process.stdin.on("data", chunk => input += chunk).on("end", () => {
    const pkg = JSON.parse(input);
    const deps = pkg.dependencies || {};
    console.log(JSON.stringify({node:pkg.engines?.node || "", csvParse:deps["csv-parse"] || "", multer:deps.multer || ""}));
  });
  ')"
  TARGET_NODE_ENGINE="$(json_get "$TARGET_PACKAGE_INFO" node)"
  case "$TARGET_NODE_ENGINE" in '>=24.0.0 <25'|'24.x'|'24') ;; *) fail "target package does not declare the supported Node 24 range: ${TARGET_NODE_ENGINE:-missing}" ;; esac
  [ -n "$(json_get "$TARGET_PACKAGE_INFO" csvParse)" ] || fail 'target package is missing csv-parse'
  [ -n "$(json_get "$TARGET_PACKAGE_INFO" multer)" ] || fail 'target package is missing multer'
  LOCK_PACKAGE_INFO="$(git show "$TARGET_COMMIT:package-lock.json" | "$NODE_BIN" -e '
  let input="";
  process.stdin.on("data", chunk => input += chunk).on("end", () => {
    const lock = JSON.parse(input);
    const deps = lock.packages?.[""]?.dependencies || {};
    console.log(JSON.stringify({csvParse:deps["csv-parse"] || "", multer:deps.multer || ""}));
  });
  ')"
  [ -n "$(json_get "$LOCK_PACKAGE_INFO" csvParse)" ] || fail 'package-lock is missing csv-parse'
  [ -n "$(json_get "$LOCK_PACKAGE_INFO" multer)" ] || fail 'package-lock is missing multer'
  log "target package contract node=$TARGET_NODE_ENGINE csv-parse=$(json_get "$TARGET_PACKAGE_INFO" csvParse) multer=$(json_get "$TARGET_PACKAGE_INFO" multer) lockfile=verified"

STAGE=load_actual_systemd_context
parse_unit_context "$WEB_SERVICE" WEB
parse_unit_context "$BOT_SERVICE" BOT
assert_no_opposite_systemd_exec
check_service_node24
assert_scheduler_disabled
assert_runtime_roles

STAGE=readonly_production_probe
PROBE_OUTPUT="$(run_unit WEB \
  --setenv=PRODUCTION_IDENTITY_VERIFIED=YES \
  --setenv=PRODUCTION_STORAGE_VERIFIED=YES \
  "$NODE_BIN" - <<'NODE'
const { inspectProductionDatabaseConfig } = require('./utils/productionDatabaseConfig');
const cfg = inspectProductionDatabaseConfig(process.env);
if (!cfg.ok) { console.error(cfg.errors.join('; ')); process.exit(1); }
console.log('MIHU_JSON:' + JSON.stringify({databasePath:cfg.databasePath,dataDir:process.env.PRODUCTION_DATA_DIR || '',backupDir:process.env.DATABASE_BACKUP_DIR || '',port:process.env.PORT || '3000'}));
NODE
)"
PROBE_JSON="$(extract_json_marker "$PROBE_OUTPUT")" || fail 'production path probe returned no JSON'
DATABASE_PATH="$(json_get "$PROBE_JSON" databasePath)"
PRODUCTION_DATA_DIR="$(json_get "$PROBE_JSON" dataDir)"
DATABASE_BACKUP_DIR="$(json_get "$PROBE_JSON" backupDir)"
WEB_PORT="$(json_get "$PROBE_JSON" port)"
[ "$DATABASE_PATH" = "$EXPECTED_DATABASE_PATH" ] || fail "database path differs from expected $EXPECTED_DATABASE_PATH"
[ -n "$DATABASE_BACKUP_DIR" ] || fail 'DATABASE_BACKUP_DIR missing from actual common EnvironmentFile'
[ -n "$PRODUCTION_DATA_DIR" ] || fail 'PRODUCTION_DATA_DIR missing from actual common EnvironmentFile'
[ -f "$DATABASE_PATH" ] || fail 'Production database is missing'
[ -d "$PRODUCTION_DATA_DIR" ] || fail 'Production JSON mirror directory is missing'
[ -d "$DATABASE_BACKUP_DIR" ] || fail 'Production backup directory is missing'
: "${WEB_PORT:=3000}"

STAGE=confirm_production_context
if [ "${PRODUCTION_CONTEXT_CONFIRMED:-}" != YES ]; then
  read -r -p 'Confirm this is the intended VPS, persistent production volume and database identity. Type YES: ' PRODUCTION_CONTEXT_CONFIRMED
fi
[ "${PRODUCTION_CONTEXT_CONFIRMED:-}" = YES ] || fail 'production identity/storage not confirmed'
DEPLOYMENT_FLOW="$(printf '%s' "$DEPLOYMENT_FLOW" | tr '[:lower:]' '[:upper:]')"
case "$DEPLOYMENT_FLOW" in UPDATE|GO_LIVE) ;; *) fail 'DEPLOYMENT_FLOW must be UPDATE or GO_LIVE' ;; esac
if [ -z "$PREFLIGHT_MODE" ]; then
  if [ "$DEPLOYMENT_FLOW" = UPDATE ]; then PREFLIGHT_MODE=INITIALIZATION; else PREFLIGHT_MODE=GO_LIVE; fi
fi
PREFLIGHT_MODE="$(printf '%s' "$PREFLIGHT_MODE" | tr '[:lower:]' '[:upper:]')"
case "$PREFLIGHT_MODE" in INITIALIZATION|GO_LIVE) ;; *) fail 'PREFLIGHT_MODE must be INITIALIZATION or GO_LIVE' ;; esac
if [ "$DEPLOYMENT_FLOW" = GO_LIVE ] && [ "$PREFLIGHT_MODE" != GO_LIVE ]; then fail 'GO_LIVE flow requires PREFLIGHT_MODE=GO_LIVE'; fi
if [ "$DEPLOYMENT_FLOW" = UPDATE ] && [ "$PREFLIGHT_MODE" != INITIALIZATION ]; then fail 'UPDATE flow requires PREFLIGHT_MODE=INITIALIZATION'; fi
LOCAL_STAGING_CONFIRMED=""
read -r -p '/var/backups/mihu is a VPS-local temporary staging directory, not offsite backup. Confirm it is suitable for temporary staging and will be transferred to Windows before migration. Type YES: ' LOCAL_STAGING_CONFIRMED
[ "${LOCAL_STAGING_CONFIRMED:-}" = YES ] || fail 'local backup staging not confirmed'
if [ -z "${BACKUP_OPERATION_CONFIRMED:-}" ]; then
  read -r -p 'Authorize a fresh verified database backup before migration. Type YES: ' BACKUP_OPERATION_CONFIRMED
fi
[ "${BACKUP_OPERATION_CONFIRMED:-}" = YES ] || fail 'backup operation not confirmed'

STAGE=read_only_initialization_preflight
run_read_only_preflight "$PREFLIGHT_MODE"

STAGE=capture_original_services
if service_is_active "$WEB_SERVICE"; then WEB_WAS_ACTIVE=1; fi
if service_is_active "$BOT_SERVICE"; then BOT_WAS_ACTIVE=1; fi
SERVICE_STATE_CAPTURED=1
log "original_services web_active=$WEB_WAS_ACTIVE bot_active=$BOT_WAS_ACTIVE"
printf '{"rollbackVersion":"%s","target":"%s","webWasActive":%s,"botWasActive":%s,"database":"%s","webEnvironmentFiles":%s,"botEnvironmentFiles":%s}\n' \
  "$PRE_HEAD" "$TARGET_COMMIT" "$WEB_WAS_ACTIVE" "$BOT_WAS_ACTIVE" "$DATABASE_PATH" \
  "$(printf '%s\n' "${WEB_ENVFILES[@]}" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.stringify(s.trim().split(/\r?\n/).filter(Boolean))))')" \
  "$(printf '%s\n' "${BOT_ENVFILES[@]}" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.stringify(s.trim().split(/\r?\n/).filter(Boolean))))')" \
  > "$STATE_DIR/original-state.json"
log "original state record=$STATE_DIR/original-state.json"

STAGE=freeze_writers
stop_all_writers
capture_financial_fingerprint "$BASELINE_FILE"
BASELINE_FINGERPRINT="$(json_get "$(cat "$BASELINE_FILE")" fingerprint)"
[[ "$BASELINE_FINGERPRINT" =~ ^[a-f0-9]{64}$ ]] || fail 'financial baseline fingerprint invalid'

STAGE=create_backup
BACKUP_TOOL_DIR="${TRANSFER_PARENT%/}/mihu-salary-backup-tool-${TARGET_COMMIT}-$$"
[ ! -e "$BACKUP_TOOL_DIR" ] || fail "target backup tool sandbox already exists: $BACKUP_TOOL_DIR"
sudo install -d -o "$(id -un)" -g mihu -m 2770 "$BACKUP_TOOL_DIR"
git archive "$TARGET_COMMIT" \
  scripts/backupDatabase.js \
  utils/runtimePaths.js \
  utils/productionDatabaseConfig.js \
  utils/backupContract.js \
  utils/databaseReadiness.js \
  | tar -x -C "$BACKUP_TOOL_DIR"
grep -Fq 'local-transfer-staging-only' "$BACKUP_TOOL_DIR/scripts/backupDatabase.js" \
  || fail 'backupDatabase.js from target release lacks local-transfer-staging contract'
sudo chown -R "$(id -un)":mihu "$BACKUP_TOOL_DIR"
sudo find "$BACKUP_TOOL_DIR" -type d -exec chmod 2750 {} +
sudo find "$BACKUP_TOOL_DIR" -type f -exec chmod 640 {} +
sudo -u mihu test -r "$BACKUP_TOOL_DIR/scripts/backupDatabase.js"
log "backup utility source release=$TARGET_COMMIT path=$BACKUP_TOOL_DIR/scripts/backupDatabase.js"
BACKUP_OUTPUT="$(run_unit WEB \
  --setenv=PRODUCTION_IDENTITY_VERIFIED=YES \
  --setenv=PRODUCTION_STORAGE_VERIFIED=YES \
  --setenv=PRODUCTION_WRITES_DISABLED=YES \
  --setenv=BACKUP_STORAGE_VERIFIED= \
  --setenv=BACKUP_STAGING_CONFIRM=YES \
  --setenv=BACKUP_TRANSFER_PENDING=YES \
  --setenv=BACKUP_CONFIRM=YES \
  --setenv=NODE_PATH="$APP_DIR/node_modules" \
  "$NODE_BIN" "$BACKUP_TOOL_DIR/scripts/backupDatabase.js")"
printf '%s\n' "$BACKUP_OUTPUT"
BACKUP_PARSE_OUTPUT="$("$NODE_BIN" "$SCRIPT_DIR/verifySalaryBackupStaging.js" --mode parse --report-output "$BACKUP_OUTPUT")" \
  || fail 'backup stdout did not contain a valid JSON report'
BACKUP_JSON="$(extract_json_marker "$BACKUP_PARSE_OUTPUT")" || fail 'backup report parser returned no JSON'
BACKUP_FILE="$(json_get "$BACKUP_JSON" backupFile)"
BACKUP_MANIFEST="$(json_get "$BACKUP_JSON" manifestFile)"
[ -n "$BACKUP_FILE" ] && [ -n "$BACKUP_MANIFEST" ] && {
  BACKUP_FILE_PATH="${DATABASE_BACKUP_DIR%/}/$BACKUP_FILE"
  BACKUP_MANIFEST_PATH="${DATABASE_BACKUP_DIR%/}/$BACKUP_MANIFEST"
  log "backup manifest candidate: $BACKUP_MANIFEST_PATH"
}
[ "$(json_get "$BACKUP_JSON" integrity)" = ok ] || fail 'backup integrity not ok'
[ -n "$BACKUP_FILE" ] && [ -n "$BACKUP_MANIFEST" ] || fail 'backup output lacks artifact names'
[ -n "$BACKUP_FILE_PATH" ] && [ -n "$BACKUP_MANIFEST_PATH" ] || fail 'backup paths could not be resolved from backup output'
[ "$(basename "$BACKUP_FILE")" = "$BACKUP_FILE" ] || fail 'backup output backupFile must be a filename'
[ "$(basename "$BACKUP_MANIFEST")" = "$BACKUP_MANIFEST" ] || fail 'backup output manifestFile must be a filename'
[ -s "$BACKUP_FILE_PATH" ] && [ -s "$BACKUP_MANIFEST_PATH" ] || fail 'backup file or manifest not present'
log "backup manifest created: $BACKUP_MANIFEST_PATH"

STAGING_VERIFY_OUTPUT="$(run_unit WEB \
  "$NODE_BIN" "$SCRIPT_DIR/verifySalaryBackupStaging.js" \
  --report-json "$BACKUP_JSON" --backup-dir "$DATABASE_BACKUP_DIR")"
printf '%s\n' "$STAGING_VERIFY_OUTPUT"
STAGING_VERIFY_JSON="$(extract_json_marker "$STAGING_VERIFY_OUTPUT")" || fail 'target backup staging verifier returned no result'
[ "$(json_get "$STAGING_VERIFY_JSON" status)" = BACKUP_STAGING_VERIFIED ] || fail 'target backup manifest staging contract failed'

STAGE=prepare_windows_transfer
BACKUP_STEM="${BACKUP_FILE%.sqlite}"
SAFE_STEM="$(printf '%s' "$BACKUP_STEM" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-')"
NONCE="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
TRANSFER_ID="salary-${SAFE_STEM}-$(date -u +%Y%m%d%H%M%S)-${NONCE}"
TRANSFER_ROOT="${TRANSFER_PARENT%/}/$TRANSFER_ID"
TRANSFER_RECEIPT="$TRANSFER_ROOT/receipt.json"
[ ! -e "$TRANSFER_ROOT" ] || fail "transfer path already exists: $TRANSFER_ROOT"
sudo install -d -o deploy -g mihu -m 2770 "$TRANSFER_ROOT"
run_unit WEB \
  --setenv=PRODUCTION_IDENTITY_VERIFIED=YES \
  --setenv=PRODUCTION_STORAGE_VERIFIED=YES \
  "$NODE_BIN" scripts/prepareFinancialBackupTransfer.js \
  --backup-dir "$DATABASE_BACKUP_DIR" --backup-file "$BACKUP_FILE" --manifest-file "$BACKUP_MANIFEST" \
  --data-dir "$PRODUCTION_DATA_DIR" --output-dir "$TRANSFER_ROOT" \
  --release "$TARGET_COMMIT" --fingerprint "$BASELINE_FINGERPRINT" --backup-id "$TRANSFER_ID"
sudo chown -R deploy:mihu "$TRANSFER_ROOT"
sudo chmod 2770 "$TRANSFER_ROOT" "$TRANSFER_ROOT/mirrors"
sudo chmod 640 "$TRANSFER_ROOT"/database.sqlite "$TRANSFER_ROOT"/database.manifest.json \
  "$TRANSFER_ROOT"/transfer-manifest.json
for mirror in "$TRANSFER_ROOT"/mirrors/*; do [ -e "$mirror" ] || continue; sudo chmod 640 "$mirror"; done
sudo -u deploy test -r "$TRANSFER_ROOT/transfer-manifest.json"
sudo -u mihu test -x "$TRANSFER_ROOT"
sudo -u mihu test -r "$TRANSFER_ROOT/transfer-manifest.json"
sudo -u mihu test -r "$TRANSFER_ROOT/database.sqlite"

WINDOWS_TRANSFER_ROOT="${WINDOWS_BACKUP_ROOT%/}/$TRANSFER_ID"
log "WINDOWS_TRANSFER_ID=$TRANSFER_ID"
log "WINDOWS_TRANSFER_REMOTE=$SCP_TARGET:$TRANSFER_ROOT"
log "WINDOWS_TRANSFER_LOCAL=$WINDOWS_TRANSFER_ROOT"
printf '\nWindows PowerShell commands (run from the project workspace):\n'
printf '$transferId = %s\n' "'$TRANSFER_ID'"
printf '$remote = %s\n' "'$SCP_TARGET'"
printf '$remotePath = %s\n' "'$TRANSFER_ROOT'"
printf '$localPath = %s\n' "'$WINDOWS_TRANSFER_ROOT'"
printf '%s\n' 'New-Item -ItemType Directory -Force -Path $localPath | Out-Null'
printf '%s\n' 'scp -r "${remote}:${remotePath}/." "$localPath"'
printf '%s\n' 'node .\scripts\verifyFinancialBackupReceipt.js --mode local --root $localPath --receipt (Join-Path $localPath "receipt.json")'
printf '%s\n\n' 'scp (Join-Path $localPath "receipt.json") "${remote}:${remotePath}/receipt.json"'
log "Windows receipt upload destination=${SCP_TARGET}:${TRANSFER_RECEIPT}"
read -r -p 'After Windows local hash/integrity verification and receipt upload, type TRANSFER_READY: ' TRANSFER_READY
[ "$TRANSFER_READY" = TRANSFER_READY ] || fail 'Windows receipt step not confirmed'
[ -f "$TRANSFER_RECEIPT" ] && [ ! -L "$TRANSFER_RECEIPT" ] || fail 'uploaded receipt missing or symlinked'
sudo chgrp mihu "$TRANSFER_RECEIPT"
sudo chmod 640 "$TRANSFER_RECEIPT"
sudo -u deploy test -r "$TRANSFER_RECEIPT"
sudo -u mihu test -r "$TRANSFER_RECEIPT"
run_unit WEB \
  --setenv=PRODUCTION_IDENTITY_VERIFIED=YES \
  --setenv=PRODUCTION_STORAGE_VERIFIED=YES \
  "$NODE_BIN" scripts/verifyFinancialBackupReceipt.js --mode vps \
  --root "$TRANSFER_ROOT" --receipt "$TRANSFER_RECEIPT" \
  --release "$TARGET_COMMIT" --fingerprint "$BASELINE_FINGERPRINT"
BACKUP_STORAGE_VERIFIED=YES
log 'external backup storage confirmed by matching Windows receipt; migration gate enabled'
BACKUP_MANIFEST_PATH="$TRANSFER_ROOT/database.manifest.json"

STAGE=confirm_migration
if [ "${SALARY_MIGRATION_CONFIRMED:-}" != YES ]; then
  read -r -p "Authorize schema-only salary migration for $TARGET_COMMIT; no salary rules, payouts or permissions are created. Type MIGRATE_SALARY_SCHEMA: " SALARY_MIGRATION_CONFIRMED
fi
[ "${SALARY_MIGRATION_CONFIRMED:-}" = MIGRATE_SALARY_SCHEMA ] || fail 'explicit salary migration confirmation missing'

STAGE=update_code
run_with_code_umask git checkout --detach "$TARGET_COMMIT"
CODE_UPDATED=1
[ "$(git rev-parse --verify HEAD)" = "$TARGET_COMMIT" ] || fail 'checkout did not reach requested target'
if [ "$DEPENDENCIES_CHANGED" -eq 1 ]; then
  [ -f package-lock.json ] || fail 'target dependency change has no package-lock.json'
  run_with_code_umask "$NPM_BIN" ci --omit=dev
fi
assert_service_access
assert_scheduler_disabled

STAGE=explicit_migration
MIGRATION_ATTEMPTED=1
run_unit WEB \
  --setenv=PRODUCTION_IDENTITY_VERIFIED=YES \
  --setenv=PRODUCTION_STORAGE_VERIFIED=YES \
  --setenv=PRODUCTION_WRITES_DISABLED=YES \
  --setenv=BACKUP_STORAGE_VERIFIED="$BACKUP_STORAGE_VERIFIED" \
  --setenv=MIGRATION_CONFIRM=YES \
  --setenv=MIGRATION_BACKUP_MANIFEST="$BACKUP_MANIFEST_PATH" \
  "$NODE_BIN" scripts/migrateDatabase.js
MIGRATION_COMPLETED=1

STAGE=readiness
run_readiness WEB
run_readiness BOT
read_only_salary_schema_check
capture_financial_fingerprint "$POST_FILE"
compare_financial_fingerprints
assert_scheduler_disabled
POST_MIGRATION_VALIDATED=1

STAGE=restore_original_service_states
if [ "$WEB_WAS_ACTIVE" -eq 1 ]; then sudo systemctl start "$WEB_SERVICE"; else sudo systemctl stop "$WEB_SERVICE"; fi
if [ "$BOT_WAS_ACTIVE" -eq 1 ]; then sudo systemctl start "$BOT_SERVICE"; else sudo systemctl stop "$BOT_SERVICE"; fi
if [ "$WEB_WAS_ACTIVE" -eq 1 ]; then
  local_code=''
  for attempt in $(seq 1 30); do
    login_code="$(curl --silent --connect-timeout 2 --max-time 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${WEB_PORT}/login" || true)"
    health_code="$(curl --silent --connect-timeout 2 --max-time 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${WEB_PORT}/healthz" || true)"
    [ "$login_code" = 200 ] && [ "$health_code" = 200 ] && break
    sleep 2
  done
  [ "${login_code:-}" = 200 ] && [ "${health_code:-}" = 200 ] || fail "post-deploy HTTP checks failed login=${login_code:-000} healthz=${health_code:-000}"
fi
if [ "$WEB_WAS_ACTIVE" -eq 1 ]; then service_is_active "$WEB_SERVICE" || fail 'Web was active before deploy but is inactive now'; fi
if [ "$BOT_WAS_ACTIVE" -eq 1 ]; then service_is_active "$BOT_SERVICE" || fail 'Bot was active before deploy but is inactive now'; fi
if [ "$WEB_WAS_ACTIVE" -eq 0 ]; then ! service_is_active "$WEB_SERVICE" || fail 'Web was inactive before deploy but is active now'; fi
if [ "$BOT_WAS_ACTIVE" -eq 0 ]; then ! service_is_active "$BOT_SERVICE" || fail 'Bot was inactive before deploy but is active now'; fi
assert_scheduler_disabled

trap - ERR INT TERM
log 'SALARY_DEPLOYMENT_SUCCESS'
log "target=$TARGET_COMMIT rollback_version=$PRE_HEAD"
log "database=$DATABASE_PATH backup=$BACKUP_FILE_PATH backup_manifest=$BACKUP_MANIFEST_PATH"
log "transfer_id=$TRANSFER_ID transfer_root=$TRANSFER_ROOT windows_receipt=$WINDOWS_TRANSFER_ROOT/receipt.json"
log "original_service_state web=$WEB_WAS_ACTIVE bot=$BOT_WAS_ACTIVE; scheduler remains disabled"
log "state_dir=$STATE_DIR"
