# 統一權限矩陣

基準版本：4560bcb7527b3f4959f2f72ad1c933ec8f73d2e0。

## 格式與轉換

讀取支援 JSON string 陣列及 key → boolean 物件，只有嚴格的 true 才授权。舊名稱只由共用解析器轉譯；查詢、登入與啟動不更新資料庫。授權結果、路由及 Sidebar 使用標準 Key。

授權保存仍經過角色委派與 CSRF；在明確儲存時寫入標準 Key 陣列。原有未知資料存在時，寫入 boolean 物件並原樣保留未知值；未知資料不授權，也不能由請求新注入。非最高權限仍不能編輯帶未知資料的角色。格式損壞的角色拒絕修改。

只儲存原始選取，不把衍生權限寫回。未實作獨立檢查的既有項目唯讀保留，既有 true 值不會因儲存而消失。

## 獨立授權

view_manage_members 只控制會員名單，view_member_ledger 獨立控制資金明細。view_manage_staff、view_staff_payroll、action_staff_sensitive、action_staff_payroll 及各提款操作保持獨立。view_system 目前未實作獨立目錄檢查，不是授予全部系統權限的總開關。

既有總授權也有獨立標準 Key，其推導能力完全保留，沒有與細項合併或新增授權。action_order_refund 控制作廢退款；並未新增實體刪除、批次核薪或訂單請款功能。沒有既有後端能力的 action_order_payout、action_bot_control 不建立假 Switch。

## 中文標籤與映射

「查看會員」「管理會員」「查看營運統計」「查看 Discord 狀態」是標籤，不是可直接授權的中文 Key。「查看營運累計」與「查看未來預估」沒有獨立 Key，既有分析頁對應 action_view_analytics。

| 中文名稱 | 舊 Key | 標準 Key | 直接推導 |
|---|---|---|---|
| 查看系統狀態 | `system_health.view` | `view_system_health` | — |
| 查看營運統計 | `analytics.view` | `action_view_analytics` | — |
| 查看操作紀錄 | `audit_logs.view` | `action_view_audit_logs` | — |
| 查看系統設定 | `system_settings.view` | `view_system_settings` | — |
| 管理系統設定 | `system_settings.manage` | `action_system_config` | view_system_settings |
| 查看 Discord 狀態 | `discord_control.view` | `view_discord_status` | — |
| 部署開發 Discord 指令 | `discord_commands.deploy_dev` | `action_bot_deploy_dev` | — |
| 部署正式 Discord 指令 | `discord_commands.deploy_production` | `action_bot_deploy_production` | — |
| 查看會員 | `members.view` | `view_manage_members` | — |
| 管理會員 | `members.manage` | `action_member_manage` | view_manage_members |
| 查看會員資金明細 | `member_ledger.view` | `view_member_ledger` | — |
| 查看身分管理 | `roles.view` | `view_roles` | — |
| 管理身分與權限 | `roles.manage` | `action_role_manage` | view_roles |
| 查看員工 | `staff.view` | `view_manage_staff` | — |
| 管理員工 | `staff.manage` | `action_staff_manage` | view_manage_staff |
| 查看員工敏感資料 | `staff.view_sensitive` | `action_staff_sensitive` | — |
| 查看 VIP | `vip.view` | `view_vip` | — |
| 管理 VIP | `vip.manage` | `action_vip_config` | view_vip |
| 查看訂單 | `orders.view` | `view_manage_orders` | — |
| 管理訂單 | `orders.manage` | `action_order_manage` | view_manage_orders |
| 調整訂單價格 | `orders.price_adjust` | `action_order_price` | — |
| 退款訂單 | `orders.refund` | `action_order_refund` | view_manage_orders |
| 核准完成訂單退款 | `orders.refund_completed` | `action_order_refund_completed` | — |
| 查看抽佣 | `commission.view` | `view_commission` | — |
| 管理抽佣 | `commission.manage` | `action_commission_config` | view_commission |
| 查看薪轉 | `payroll.view` | `view_staff_payroll` | — |
| 管理薪轉 | `payroll.manage` | `action_staff_payroll` | view_staff_payroll |
| 查看提款 | `payout.view` | `view_payout` | — |
| 匯出提款資料 | `payout.export` | `action_payout_export` | view_payout |
| 查看提款敏感資料 | `payout.view_sensitive` | `action_payout_sensitive` | view_payout |
| 標記提款已匯款 | `payout.mark_paid` | `action_payout_mark_paid` | — |
| 駁回提款申請 | `payout.reject` | `action_payout_reject` | view_payout |
| 首頁儀表板 | `home` | `view_dashboard` | — |
| 首頁 Banner（唯讀保留） | `home_banner` | `view_dashboard_banner` | — |
| 首頁錢包卡片（唯讀保留） | `home_wallet_card` | `view_dashboard_wallet` | — |
| 首頁公告與資訊（唯讀保留） | `home_info` | `view_dashboard_info` | — |
| 個人專區目錄 | `personal` | `view_personal` | — |
| 個人檔案 | `profile` | `view_profile` | — |
| Discord 綁定資訊（唯讀保留） | `profile_discord` | `view_profile_discord` | — |
| 變更暱稱（唯讀保留） | `profile_nickname` | `action_profile_nickname` | — |
| 我的錢包 | `my_wallet` | `view_wallet` | — |
| 我的收入 | `my_income` | `view_income` | — |
| 我的訂單 | `my_orders` | `view_personal_orders` | — |
| 工作室管理目錄（唯讀保留） | `manage` | `view_management` | — |
| 會員管理完整授權 | `manage_members` | `action_member_management` | view_manage_members、action_member_manage、view_member_ledger |
| 手動調整會員帳務 | `member_adjust_balance` | `action_member_balance` | — |
| 調整會員身分與 VIP | `member_adjust_vip` | `action_member_role_vip` | — |
| 員工管理完整授權 | `manage_staff` | `action_staff_management` | view_manage_staff、action_staff_manage |
| 訂單管理完整授權 | `manage_orders` | `action_order_management` | action_view_analytics、view_manage_orders、action_order_manage |
| 系統控制目錄（唯讀保留） | `system` | `view_system` | — |
| 抽成檢視與管理 | `sys_commission` | `action_commission_management` | view_commission、action_commission_config |
| VIP 檢視與管理 | `sys_vip` | `action_vip_management` | view_vip、action_vip_config |
| 身分檢視與管理 | `sys_roles` | `action_role_management` | view_roles、action_role_manage |
| 系統完整管理 | `sys_settings` | `action_system_management` | view_system_settings、action_system_config、view_discord_status、action_view_audit_logs、view_system_health |
| 系統日誌選單（唯讀保留） | `sys_logs` | `view_system_logs` | — |
| 查看員工個資與薪資 | `staff_view_payroll` | `action_staff_payroll_details` | view_manage_staff、action_staff_sensitive、view_staff_payroll |
| 修改員工身分與抽成 | `staff_edit_role_commission` | `action_staff_commission` | — |
| 訂單維護與改派（唯讀保留） | `orders_edit_and_reassign` | `action_order_reassign` | — |

## 部署

不需要資料庫 migration、seed 或重新匯入角色。新儲存的標準 Key 需要本版本 resolver；程式回退到不認識標準 Key 的舊版本前需另行規劃相容性，不能直接回退後忽略新格式。

本機套用 patch 後先執行 npm test 與 git diff --check，再由使用者提交、推送及部署。正式站採 systemd，部署成功後使用 sudo systemctl restart mihu-web，不使用 PM2。
