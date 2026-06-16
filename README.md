# ghaction-lis (GitHub Action Listener)

> 一個輕量級的 CLI 工具，讓你直接在終端機監聽 GitHub Actions 的部署狀態。🚀

再也不用頻繁切換視窗了！你不需要每次 `git push` 後都打開瀏覽器確認 CI/CD 是否通過。`ghaction-lis` 能直接在你的終端機內運行，即時回報進度，如果執行失敗，還能立刻找出並印出報錯的 Job 連結！

## ✨ 核心特色

- **零設定 (Zero Config)**：自動解析你當前的 Git 專案，完全不需要任何設定檔。
- **無縫認證**：支援環境變數與 `gh` CLI，甚至支援免 Token 的公開專案訪客模式。
- **防止 Race Condition**：精準鎖定你剛推上去的 `head_sha`，絕對不會抓到舊的歷史紀錄。
- **智慧錯誤定位**：如果 Action 失敗，會直接在終端機印出精確的報錯網址，點擊即可修復。

## 📦 安裝方式

透過 npm 進行全域安裝：

```bash
npm install -g ghaction-lis
```

### 🔐 認證需求

本工具建議提供 GitHub Token 以確保穩定性。我們支援以下三種情境：

1. **設定環境變數（優先）**：`export GITHUB_TOKEN=你的金鑰`
2. **使用 GitHub CLI**：直接安裝官方 [`gh` CLI](https://cli.github.com/) 並完成登入 (`gh auth login`)。
3. **無 Token 模式（新手友善）**：如果你不想提供 Token，且專案是**公開專案 (Public Repo)**，工具依然可以運作！但會受限於 GitHub 的 API 限制（每小時 60 次），且若為私有專案 (Private) 則會被 GitHub 拒絕存取並給予友善提示。

## 🚀 使用說明

在任何有設定 GitHub Actions 的專案目錄下，推播程式碼後直接輸入指令：

```bash
git push
ghaction-lis
```

### 參數說明

| 參數 | 說明 |
| :--- | :--- |
| `--open` | 部署成功後，自動呼叫系統預設瀏覽器開啟 GitHub 紀錄網頁。 |
| `--timeout <number>` | 自訂監聽逾時的分鐘數（預設為 30 分鐘）。 |

## 💻 終端機情境範例

### 🟢 情境一：執行成功 (Success)
```text
✔ 成功鎖定專案：liwenchiou/ghaction-lis
✔ 鎖定目標：Run ID #27612172810 (chore: 測試一下流程)
⠋ GitHub Action 執行中 (in_progress)，已耗時 12s...

✔ Action 執行成功！🎉 (總耗時: 21s)
🔗 點擊查看紀錄: https://github.com/liwenchiou/ghaction-lis/actions/runs/27612172810
```

### 🔴 情境二：執行失敗 (Failure)
```text
✔ 成功鎖定專案：liwenchiou/ghaction-lis
✔ 鎖定目標：Run ID #27612307032 (test: 模擬打包出錯)
⠋ GitHub Action 執行中 (in_progress)，已耗時 18s...

✖ Action 執行失敗！🔥 (結論: failure, 總耗時: 27s)
❌ Job [test-run] 發生錯誤
🔗 點擊查看紀錄: https://github.com/liwenchiou/ghaction-lis/actions/runs/27612307032/job/81639950470
```

### 🟡 情境三：未提供 Token 且為私有專案 (Private Repo)
```text
⚠ 未偵測到 GitHub Token！將以「未登入」身分呼叫 API。
👉 注意：這僅適用於「公開專案 (Public)」，且受限於 GitHub 每小時 60 次的呼叫限制...
✔ 成功鎖定專案：liwenchiou/my-private-repo
- 正在抓取本地最新 Commit Hash...

✖ 發生未預期的系統錯誤！

👉 提示：GitHub 拒絕了存取 (Not Found)。
這通常是因為這是一個「私有專案 (Private Repo)」，而您目前處於未登入狀態。
請設定環境變數 GITHUB_TOKEN，或執行 `gh auth login` 來取得存取權限！
```

## 💡 最佳實踐：結合 npm scripts

最順暢的體驗是把 `ghaction-lis` 和你的發佈指令綁定在 `package.json` 中：

```json
{
  "scripts": {
    "deploy": "git push && ghaction-lis"
  }
}
```

設定好之後，未來只要執行 `npm run deploy`，終端機就會幫你自動完成推播與即時監聽！

## 📄 授權條款
MIT License
