<p align="center">
  <p align="center">
   <img width="150" height="150" src="https://github.com/CapSoftware/Cap/blob/main/apps/desktop/src-tauri/icons/Square310x310Logo.png" alt="Logo">
  </p>
	<h1 align="center"><b>Cap</b></h1>
	<p align="center">
		Loom 的開源替代方案
    <br />
    <a href="https://cap.so"><strong>Cap.so »</strong></a>
    <br />
    <br />
    <b>下載適用版本 </b>
		<a href="https://cap.so/download">macOS 與 Windows</a>
    <br />
  </p>
</p>
<br/>

[![Open Bounties](https://img.shields.io/endpoint?url=https%3A%2F%2Fconsole.algora.io%2Fapi%2Fshields%2FCapSoftware%2Fbounties%3Fstatus%3Dopen)](https://console.algora.io/org/CapSoftware/bounties?status=open)

Cap 是 Loom 的開源替代方案。它是一款視訊通話工具，能讓你在數秒內錄製、編輯並分享影片。

<img src="https://raw.githubusercontent.com/CapSoftware/Cap/refs/heads/main/apps/web/public/landing-cover.png"/>

# 自行架設（Self Hosting）

Cap Web 可透過 Docker 或 Railway 進行自行架設，想了解更多請參考我們的[self-hosting docs](https://cap.so/docs/self-hosting)。
你也可以使用下方按鈕，將 Cap Web 部署到 Railway：

[![在 Railway 部署](https://railway.com/button.svg)](https://railway.com/new/template/PwpGcf)

無論你是自行架設，或是[從我們的網站下載](https://cap.so/download)，Cap Desktop 都能連線到你自行架設的 Cap Web 。

# Monorepo 應用架構

這個由 Turborepo 驅動的 monorepo 使用 Rust、React（Next.js）、TypeScript、Tauri、Drizzle（ORM）、MySQL、TailwindCSS 等技術的組合。

> 關於資料庫的注意事項：目前程式碼僅設計支援 MySQL。MariaDB 或其他相容資料庫可能可部分運作，但未獲官方支援。

### 應用（Apps）：

- `desktop`： [Tauri](https://tauri.app)（Rust），前端使用 [SolidStart](https://start.solidjs.com)。
- `web`： [Next.js](https://nextjs.org) 。

### 套件（Packages）：

- `ui`： [React](https://reactjs.org) 的共用元件庫。
- `utils`： [React](https://reactjs.org) 的共用工具庫。
- `tsconfig`：在整個 monorepo 中共用的 `tsconfig` 設定。
- `database`： [React](https://reactjs.org) 與 [Drizzle ORM](https://orm.drizzle.team/) 的共用資料庫程式庫。
- `config`：`eslint` 設定（包含 `eslint-config-next`、`eslint-config-prettier` 等在 monorepo 中使用的其他設定）。

### 授權（License）：
本軟體的授權條款部分如下：

- `cap-camera*` 與 `scap-*` 系列 crate 中的所有程式碼皆採用 MIT 授權（見 [licenses/LICENSE-MIT](https://github.com/CapSoftware/Cap/blob/main/licenses/LICENSE-MIT)）。
- 所有第三方元件皆依其擁有者提供的原始授權條款授權。
- 其餘未於上述提及的內容皆依 [LICENSE](https://github.com/CapSoftware/Cap/blob/main/LICENSE) 中定義的 AGPLv3 授權提供。
  
# 貢獻（Contributing）

更多資訊請見 [CONTRIBUTING.md](CONTRIBUTING.md)。本指南仍在持續完善，會隨著應用成熟而定期更新。

## 分析（Tinybird）

Cap 使用 [Tinybird](https://www.tinybird.co) 收集觀眾遙測資料以建立儀表板。Tinybird Admin Token（`TINYBIRD_ADMIN_TOKEN` 或 `TINYBIRD_TOKEN`）必須存在於你的環境中。當 Token 準備就緒後，你可以：

- 透過 `pnpm analytics:setup` 佈建需要的資料來源與實體化檢視。這個指令會在需要時安裝 Tinybird CLI；當缺少 `.tinyb` 認證檔案時執行 `tb login`；將該認證複製到 `scripts/analytics/tinybird`；最後在該目錄執行 `tb deploy --allow-destructive-operations --wait`。**它會把 Tinybird 工作區同步到 `scripts/analytics/tinybird` 定義的資源，並移除該工作區中任何其他的資料來源/管線。**
- 透過 `pnpm analytics:check` 驗證資料結構與實體化檢視是否符合應用的預期。

兩個指令都會針對由 `TINYBIRD_HOST` 指定的工作區（預設為 `https://api.tinybird.co`）。在執行 `analytics:setup` 之前，請務必了解部署步驟具破壞性所帶來的影響並確認你能接受。
