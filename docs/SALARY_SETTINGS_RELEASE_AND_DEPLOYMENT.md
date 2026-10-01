# 薪資設定模組發布與部署

狀態：僅供合併後的 VPS 操作者使用。本次開發沒有連線 VPS、執行正式 migration、建立正式備份或授予任何權限。

## 變更範圍

- Web 提供 `/management/salary-settings`；員工、工作室與角色查詢均由登入者的工作室範圍限制。
- 薪資調整及固定月薪派發寫入 `salary_adjustments`，不修改會員錢包。
- `payoutService.getPayoutSummary()` 將可提領 delta、固定月薪 earned delta、歷史收入 delta 分開計算；待提領仍列入既有 reserve，已結清提款不改寫。
- CSV/XLSX 上傳使用記憶體暫存，沒有公開目錄或磁碟暫存檔。
- 月薪 scheduler 由 Web (`index.js`, `MIHU_RUNTIME_ROLE=web`) 承載；Bot 不啟動 scheduler。所有派發經同一 service，SQLite transaction、規則月份批次唯一鍵與批次員工唯一鍵共同防重。
- 排程預設關閉。使用者明確審核角色薪資規則、派發日及首輪執行時點後，才可在 `/etc/mihu/mihu-web.env` 設定 `SALARY_SCHEDULER_ENABLED=true`。發放時刻預設為 `Asia/Taipei` 00:00；若延遲或 Web 停機，恢復後只補當月，不回補過往月份。月底日數會夾到當月最後一天。
- 範例設定見 [`deploy/env/mihu-web.env.example`](../deploy/env/mihu-web.env.example)。不設定 scheduler 仍可手動預覽及派發。

## Migration 與 Readiness

本次增加薪資規則角色／項目／發放日、派發快照、調整 delta 分桶、手動預覽、匯入批次／預覽及 scheduler run tables/indexes/triggers。Migration 可重跑；舊版員工規則、批次與 adjustment 保留，既有 manual/import amount 回填至 available delta，舊固定月薪派發回填至 earned delta。Migration 不寫 `user_wallets`、不改既有 payout rows，也不授予任何 role permission。

由於 Web/Bot startup 只做 read-only readiness，本版不能只重啟 Web 或略過 migration。必須依 [`docs/PRODUCTION_VPS_RUNBOOK.md`](PRODUCTION_VPS_RUNBOOK.md) 的 Backup 與 Explicit Migration 契約，先停止所有 DB writers、建立外部備份並驗證 manifest，再執行 `npm run db:migrate`；成功後執行 `npm run db:readiness`。任何 migration/readiness 非零結果都維持服務停止並調查，不可略過檢查啟動。

## VPS 操作順序

以下命令是部署方案，不代表已執行。需由獲授權的 VPS 操作者依核准變更單操作；不得把 secrets 放入 repo、PR、shell history 或回報內容。

1. 確認已合併的完整 SHA、VPS branch/status 與資料庫身份；`git status --short` 必須乾淨。`git fetch origin` 後檢視 `HEAD..origin/main`，只部署核准的 merge commit。
2. 記錄 Web/Bot 原本是否 active，停止所有 DB writers：`sudo systemctl stop mihu-web.service mihu-bot.service`。確認沒有其他 maintenance writer。
3. 在 `/opt/mihu/app` 以既有 Production env 執行 `npm run db:backup`。設定 one-shot `BACKUP_CONFIRM=YES`、`PRODUCTION_IDENTITY_VERIFIED=YES`、`PRODUCTION_STORAGE_VERIFIED=YES`、`PRODUCTION_WRITES_DISABLED=YES`、`BACKUP_STORAGE_VERIFIED=YES` 及 `DATABASE_BACKUP_DIR=/var/backups/mihu`。保留命令輸出的 backup/manifest 路徑與 SHA，確認備份位於核准的獨立儲存並完成外部副本驗證。
4. Fast-forward 到核准的 merge SHA；依既有 runtime 契約執行 `npm ci`，安裝鎖定的 `csv-parse` dependency。安裝不得觸發 migration、seed 或 RBAC bootstrap。
5. 以剛才已驗證的 manifest 設定 `MIGRATION_CONFIRM=YES`、`MIGRATION_BACKUP_MANIFEST=/var/backups/mihu/<verified-manifest>.manifest.json`，連同 Production identity/storage、writer-freeze 與 backup-storage confirmations 執行 `npm run db:migrate`。
6. 執行 `npm run db:readiness`。確認薪資規則、adjustment delta、manual/import preview、batch snapshot、scheduler run schema 均 ready；不要執行 seed、reset、role bootstrap 或自動授權。
7. 保持 `SALARY_SCHEDULER_ENABLED=false`，先按原服務狀態恢復 Web，檢查 `systemctl status mihu-web.service`、`journalctl -u mihu-web.service`、`curl --fail http://127.0.0.1:3000/healthz`，並檢查薪資頁、既有提款摘要與錢包未變。Bot 若原本 active，完成 readiness 後按原狀態恢復；Bot 不承載薪資 scheduler。
8. 由權限管理者在角色管理介面依核准矩陣手動授予 `view_payroll` 及所需的 `action_salary_adjust`、`action_salary_import`、`action_salary_rule_manage`、`action_salary_distribute`。權限彼此獨立且不自動授予。財務負責人另行檢查角色規則、身分組、金額、發放日及當月已派發狀態。
9. 經業務明確核准後，才在 Web env 啟用 scheduler 並執行 `sudo systemctl restart mihu-web.service`。確認只有 Web runtime 啟動 scheduler，檢視 `salary_scheduler_runs` 與 Web journal。首次啟用時若規則已到期，系統會派發目前月份；先核對目標月份與規則，不可在未確認時啟用。

## Rollback

Migration 後若出錯，先停止 Web/Bot 與所有 writers。不可只把程式碼退版後假設 salary delta 已生效；如果 migration 後有任何薪資或提款寫入，單純 code rollback 會使新 adjustment 不再納入餘額計算。依 Production restore 契約建立並驗證 pre-restore backup，再以原 pre-migration manifest 和 pre-restore manifest 執行 `npm run db:restore`；保持服務停止，確認完整 integrity/readiness 後才恢復原先 active 的服務。若已有薪資交易，需先由財務核對並依正式資料修復流程處理，不可直接回復舊資料庫覆蓋新交易。

## 驗證證據與限制

- 本機 full `npm test`：288 total、287 passed、0 failed、1 skipped。唯一 skipped：`initialization Nginx template trusts CF-Connecting-IP only from trusted edges and allowlists routes`，原因 `nginx/openssl not installed`。
- Browser 使用隔離 TEMP DB 驗證手動 Modal 錯誤保留、multipart CSV server preview Modal，以及 390px viewport 無橫向溢位。測試瀏覽器無法載入 CDN 上的 Bootstrap CSS，因此已驗證互動與幾何尺寸，未宣稱視覺樣式驗收通過。
- VPS、Production DB、正式 migration、正式權限授予及正式 scheduler 首輪派發均未執行。