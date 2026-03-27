# Cap 的貢獻指南

## 介紹

### 什麼是 Cap?

Cap 是一個開源且重視隱私的 Loom 替代方案，是一個能讓你在數秒內錄製、編輯並分享影片的影片訊息工具

Cap 仍在早期開發階段，所以在我們完善這份指南的過程中，請多多包涵

### 本指南是什麼?

本指南適用於所有想要貢獻 Cap 的人，本指南仍在進行中，將會持續更新

### 如何貢獻?

有很多貢獻 Cap 的方式，你可以:

- [回報錯誤](https://github.com/CapSoftware/cap/issues/new)
- [提出功能建議 (透過 Discord)](https://discord.com/invite/y8gdQ3WRN3)
- 提交 PR

## 啟動 Cap

### 開發環境需求

在開始之前，請先確認你已安裝以下工具:

- Node Version 20+
- Rust 1.88.0+
- pnpm 8.10.5+
- Docker ([OrbStack](https://orbstack.dev/) 建議)

### 開發環境設定

先執行 `pnpm install`，接著執行 `pnpm cap-setup` 已安裝像 FFmpeg 等原生相依套件

在 Windows 上，必須安裝 llvm、clang 和 VCPKG
在 MacOS 上，必須安裝 cmake
`pnpm cap-setup` 目前尚不會自動幫你安裝這些相依套件

執行 `pnpm env-setup`，以生成一個依你環境配置的 `.env` 檔案
接著，它會詢問你打算運行哪些應用程式，是否希望使用 Docker 在本機運行 S3 (MinIO) 和 MySQL，並允許你根據需求提供覆寫設定

要同時執行 `@cap/desktop` 和 `@cap/web`，請使用 `pnpm dev`
如果只想執行其中一個，請分別使用 `pnpm dev:desktop` 或 `pnpm dev:web`

### `@cap/desktop` (桌面應用程式)

當從 macOS 上的終端機執行 `@cap/desktop` 時，
你需要授權 (螢幕錄影、麥克風等) 給終端機，而不是 Cap 應用程式
舉例來說，如果在 macOS 的 `Terminal.app` 中執行 `pnpm dev:desktop`，
你會需要授權給它，而不是 `Cap - Development.app`

#### 我錄製的影片存在哪裡?

在 macOS 上，你可以在 `~/Library/Application Support/so.cap.desktop.dev/recordings` 找到你錄製的影片；
在 Windows 上，則是在 `%programfiles%/so.cap.desktop.dev/recordings`

### `@cap/web` (cap.so 網站)

當執行 `pnpm dev` 或 `pnpm dev:web` 時，MySQL 資料庫和 MinIO S3 伺服器也會透過 Docker 運行
如果你_只想_執行 `@cap/web` 的 NextJS 應用程式，請先 `cd` 進入 `./apps/web` ，然後執行 `pnpm dev`
