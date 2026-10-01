# 正式財務歷史清理審閱紀錄（準備階段）

狀態：**未執行清理、備份、服務停止、GitHub 合併或部署**。以下是 2026-10-01 以 SQLite `OPEN_READONLY`、`PRAGMA query_only=ON` 與讀取交易取得的正式站快照，不是本機舊資料庫。正式站當時 HEAD 為 `62505ceaa18515518f6ac4f6305e0f5d05d1cbd4`，tracked 工作樹乾淨。正式操作必須另行核准新程式的 merge commit 與重新取得的預覽指紋；此處數字不能當成執行時的固定預期值。

## 正式資料盤點

| 項目 | 正式讀取結果 |
| --- | --- |
| 訂單 | 3 筆，均 `cancelled`：1 `MH-20260930-8440`、2 `MH-20260930-4465`、5 `MHM-1-20261001-00001` |
| 訂單標價／收益欄 | 標價合計 500、`talent_earning` 400、`platform_commission` 100；取消訂單不應當作現有可提領收益 |
| 建單冪等 | 3 筆，指向訂單 3、4、5；其中 3、4 不存在，形成 2 筆既有 FK 違規 |
| 錢包流水 | 13 筆：`admin_adjustment` 7 筆（合計 500）、`order_payment` 2 筆（-1000，全贈送金）、`refund` 4 筆（+1000，全贈送金） |
| 訂單參照 | 訂單 1、2 各有一筆金額 0 的退款；已刪除的訂單 3 留付款 -500／退款 +500；訂單 5 留付款 -500／退款 +500 |
| 儲值及提領 | `topups` 0、`payouts` 0、`payout_ledger` 0 |
| 使用者與錢包 | `users` 9、`user_wallets` 9；兩份鏡像的實充 0、贈送金 500、累積手動消費 0、累積儲值 0 |
| 消費同步 | `user_order_spent_sync` 1 筆，合計 0 |
| VIP | 9 人現值皆為 0；7 筆 VIP 門檻最低消費 3000／儲值 2500；audit 中有 25 筆人工 VIP／角色操作，必須保留 |
| 審計及完整性 | `audit_logs` 132 筆；`quick_check=ok`；`foreign_key_check` 有上述 2 筆孤兒冪等鍵 |
| 持久化 JSON 鏡像 | `users.json` 存在（5866 bytes）、`orders.json` 存在（2691 bytes）、`topups.json`／`payouts.json` 不存在；部署帳號無權讀 `orders.json`，**未取得正式鏡像列數或內容**。後續以 `mihu` 身分的唯讀預覽產生列數與 hash，納入審閱指紋 |

唯讀查證孤兒鍵來源：冪等 rowid 1 指向訂單 3（建於 09:43:12，09:43:19 有 `order_batch_delete_refund` 與批次 audit）；rowid 2 指向訂單 4（建於 09:43:45，09:44:31 有同類刪除 audit）。目前批次服務直接 `DELETE FROM orders`，未顯式刪除對應冪等列；既有 SQLite 連線未保證啟用 `PRAGMA foreign_keys=ON`，所以宣告的 `ON DELETE CASCADE` 未生效。本次全量清理會先刪冪等表再刪訂單，消除現存兩筆違規，但**未修復未來批次刪單的根因**；應另開小型 PR，在同一刪除交易中顯式刪該訂單的冪等鍵，並加入 `foreign_key_check` 回歸。不可把它隱藏在清理 PR 的大規模動作裡。

既有 `Web startup refuses an unprepared temporary DB` 曾兩次以 5 秒、`SIGTERM/ETIMEDOUT` 且 stdout/stderr 空白失敗；隔離分段探測中 `require(app)`、DB 及 readiness 皆能正常拒絕空 DB，直接 `index.js` 約 0.54 秒退出且輸出正確錯誤；相同測試單獨重跑與完整 `production-safety-foundation` 13/13 均通過。未修改 timeout、未略過測試，將其列為需持續觀察的間歇性 Windows 子程序／環境問題，而非已證實的清理邏輯錯誤。

其他保留項目及筆數：`announcements` 1、`bot_commands` 0、`commission_settings` 6、`commission_settings_migrations` 2、`email_verifications` 2、`role_permissions` 0、`roles` 7、`sensitive_data_migrations` 1、`studio_commissions` 6、`studio_services` 3、`studios` 1、`system_settings` 4、`talents` 4、`vip_tiers` 7。正式 schema 無自訂觸發器或 view；`order_creation_idempotency.order_id` 是指向 `orders.id` 的 `ON DELETE CASCADE`，`payout_ledger.payout_id` 指向 `payouts.id` 且無 cascade，因此清理順序先 payout ledger 與冪等，再各自的父表。

## 清理範圍與保留政策

- 刪除 `payout_ledger`、`payouts`、`order_creation_idempotency`、`orders`、`wallet_transactions`、`topups`、`user_order_spent_sync` 所有列；包括未連到現存訂單的舊付款／退款依據。這不是一般「退款並取消」API，不重新退款、結算或通知。
- 將 `users` 與 `user_wallets` 的 `balance`、`bonus_balance`、`manual_spent`、`manual_deposited` 同交易歸零。可提領收益由已完成訂單減提領衍生；清除後不得有已完成訂單或提領紀錄。
- 保留帳號／角色／權限、工作室、服務、系統／抽傭／VIP 門檻與相關遷移紀錄、email 驗證、人才設定及所有原始 `audit_logs`。交易追加一筆 `financial_history_clear`，記錄操作者、清理表筆數、審閱指紋和本地 manifest／異地副本位置。
- 四種 JSON 鏡像不是正式財務來源，但空的 `topups` 表可能在重啟時從殘留 `topups.json` 重新匯入。預覽需連同鏡像的存在狀態、筆數及 SHA-256 納入指紋；停寫後將存在的鏡像複製到本地／異地備份，清理後、啟服務前從新 DB 原子重建 `users.json`、`orders.json`、`topups.json`、`payouts.json`。後三者應為空陣列。此檔案替換不屬於 SQLite 交易；中途失敗必須保持兩服務停止，由備份人工復原，絕不假裝跨檔案原子性。
- 現值 VIP 都是 0，清理後依現行門檻試算亦為 0，因此保留該值，不覆寫人工設定。若後續預覽出現非零 VIP／未知表／觸發器／其他 FK 違規，腳本拒絕執行，須先審閱人工 VIP 來源與新 schema。

## 審閱及正式執行流程（本輪不執行）

下列命令僅是後續核准版本的操作格式，**本輪不在正式站執行**。必須先經 GitHub PR 審閱與合併，再在既有 Remote SSH 終端確認完整 release SHA；部署帳號不應繞過 `orders.json` 的檔案權限，預覽須由 `mihu` 身分執行：

```bash
cd /opt/mihu/app
sudo -u mihu env NODE_ENV=production APP_ENV=production \
	DATABASE_PATH=/var/lib/mihu/database.sqlite PRODUCTION_DATA_DIR=/var/lib/mihu/data \
	PRODUCTION_IDENTITY_VERIFIED=YES PRODUCTION_STORAGE_VERIFIED=YES \
	/usr/bin/node scripts/clearProductionFinancialHistory.js preview
```

審閱完整預覽 JSON（含 DB 與鏡像的 `fingerprint`）後，需另經維護時段與清理核准，再以 `CLEAR_RELEASE_COMMIT=<已核准完整 merge SHA>`、`CLEAR_PREVIEW_FINGERPRINT=<64 位審閱指紋>`、`CLEAR_OPERATOR_ID=<現有 admin 使用者 ID>`、`CLEAR_OFFSITE_MOUNT=<已驗證異地主機掛載目錄>` 四個環境變數執行 `bash scripts/runProductionFinancialClear.sh`。**不要**從本文件的舊快照推導或預填指紋、操作者、異地路徑或交互確認值。

1. 審閱本文件及 `scripts/clearProductionFinancialHistory.js`、`scripts/runProductionFinancialClear.sh` 的 GitHub PR，僅將已核准的完整 merge SHA 當作 `CLEAR_RELEASE_COMMIT`。保留目前未追蹤與其他未提交的 UI 修改，不得混入清理 PR。
2. 在既有 VPS Remote SSH 終端，唯讀預覽 `node scripts/clearProductionFinancialHistory.js preview`，以 Web 服務的 `mihu` 身分及已核對的正式環境／儲存路徑執行。預覽產生 DB 加四種鏡像的 SHA-256 指紋、各表筆數及財務合計；把經審閱指紋設定為 `CLEAR_PREVIEW_FINGERPRINT`。如 DB 或鏡像有變，必須重新審閱，不能自行使用新指紋直接清理。
3. 提供已核准的 `CLEAR_OPERATOR_ID` 與可寫入的**異地主機掛載點** `CLEAR_OFFSITE_MOUNT`。`scripts/runProductionFinancialClear.sh` 在確認原版 Web/Bot 都 active、tracked 工作樹乾淨、身份與資料路徑正確後才詢問第一次 `YES`。停掉兩個服務並確認 DB 無 handle、沒有 WAL/SHM/journal 殘留，再以唯讀預覽比對審閱指紋。
4. 沿用 `scripts/backupDatabase.js` 契約，以 `mihu` 身分和明確停寫／備份確認建立 `/var/backups/mihu` 的新 SQLite 備份與 manifest；複製到異地主機掛載點。另將四種鏡像中存在的檔案以 0600 複製到本地及異地 mirror archive（不存在者保留缺失狀態）；確認不同裝置及所有來源／副本 SHA-256 一致，人工核對副本可恢復後才回答第二次 `YES` 與 `CLEAR_ALL_FINANCIAL_HISTORY`。Node 執行入口再次驗證 DB manifest／異地副本及全部鏡像副本。
5. `BEGIN IMMEDIATE` 內重新逐表及逐鏡像計算 schema／所有資料 SHA-256 指紋；不符即 `ROLLBACK`。按外鍵順序刪除、核對每表影響列數、歸零 DB 的兩份錢包鏡像、寫入新 audit，再核對目標表為空、餘額及統計為 0、保留資料雜湊不變、audit 舊列仍在、FK 檢查為 0 與 SQLite 完整性；全部通過才 `COMMIT`。
6. DB 清理成功後執行 `sync-mirrors`：以 audit 中的指紋／備份位置再次驗證原鏡像與異地副本，原子替換四種正式鏡像。再次唯讀預覽確認資金與鏡像為零，才啟動原 Web/Bot，輪詢同輪 `/login` 及 `/healthz` 均為 200。**不建立真實測試訂單。** 任何交易後結果不明、鏡像替換失敗或健康檢查失敗，保持兩個寫入服務停止、保留 DB 與備份並人工調查；**不自動覆寫或還原 DB**。

恢復必須另立事故／回復核准：停止 Web/Bot，確認環境與 persistent volume，對清理後 DB **及當前 JSON 鏡像**再做一份 pre-restore 備份；依 `docs/PRODUCTION_VPS_RUNBOOK.md` 的 Restore 章節，驗證要恢復的 manifest、異地 SHA-256、來源身分與 SQLite 完整性，確認無寫入者與 sidecar 後才透過 `npm run db:restore` 的明確雙 manifest／確認契約恢復。隨同該備份恢復原四種鏡像（原先不存在者移走清理後新建的檔案），不得混用不同時間點的 DB 與鏡像。完成後執行完整性、schema/readiness 與唯讀對帳，再核准恢復服務。清理前備份／異地副本及原審計紀錄都必須保留。