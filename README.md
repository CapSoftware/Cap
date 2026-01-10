<p align="center">
  <p align="center">
   <img width="150" height="150" src="https://github.com/CapSoftware/Cap/blob/main/apps/desktop/src-tauri/icons/Square310x310Logo.png" alt="Logo">
  </p>
	<h1 align="center"><b>Cap</b></h1>
	<p align="center">
		The open source Loom alternative.
    <br />
    <a href="https://cap.so"><strong>Cap.so »</strong></a>
    <br />
    <br />
    <b>Downloads for </b>
		<a href="https://cap.so/download">macOS & Windows</a>
    <br />
  </p>
</p>
<br/>

[![Open Bounties](https://img.shields.io/endpoint?url=https%3A%2F%2Fconsole.algora.io%2Fapi%2Fshields%2FCapSoftware%2Fbounties%3Fstatus%3Dopen)](https://console.algora.io/org/CapSoftware/bounties?status=open)

Cap is the open source alternative to Loom. It's a video messaging tool that allows you to record, edit and share videos in seconds.

<img src="https://raw.githubusercontent.com/CapSoftware/Cap/refs/heads/main/apps/web/public/landing-cover.png"/>

# Self Hosting

Cap Web is available to self-host using Docker or Railway, see our [self-hosting docs](https://cap.so/docs/self-hosting) to learn more.
You can also use the button below to deploy Cap Web to Railway:

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/PwpGcf)

Cap Desktop can connect to your self-hosted Cap Web instance regardless of if you build it yourself or [download from our website](https://cap.so/download).

# Monorepo App Architecture

We use a combination of Rust, React (Next.js), TypeScript, Tauri, Drizzle (ORM), MySQL, TailwindCSS throughout this Turborepo powered monorepo.

> A note about database: The codebase is currently designed to work with MySQL only. MariaDB or other compatible databases might partially work but are not officially supported.

### Apps:

- `desktop`: A [Tauri](https://tauri.app) (Rust) app, using [SolidStart](https://start.solidjs.com) on the frontend.
- `web`: A [Next.js](https://nextjs.org) web app.

### Packages:

- `ui`: A [React](https://reactjs.org) Shared component library.
- `utils`: A [React](https://reactjs.org) Shared utility library.
- `tsconfig`: Shared `tsconfig` configurations used throughout the monorepo.
- `database`: A [React](https://reactjs.org) and [Drizzle ORM](https://orm.drizzle.team/) Shared database library.
- `config`: `eslint` configurations (includes `eslint-config-next`, `eslint-config-prettier` other configs used throughout the monorepo).

### License:
Portions of this software are licensed as follows:

- All code residing in the `cap-camera*` and `scap-*` families of crates is licensed under the MIT License (see [licenses/LICENSE-MIT](https://github.com/CapSoftware/Cap/blob/main/licenses/LICENSE-MIT)).
- All third party components are licensed under the original license provided by the owner of the applicable component
- All other content not mentioned above is available under the AGPLv3 license as defined in [LICENSE](https://github.com/CapSoftware/Cap/blob/main/LICENSE)
  
# Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for more information. This guide is a work in progress, and is updated regularly as the app matures.

## Analytics (Tinybird)

Cap uses [Tinybird](https://www.tinybird.co) to ingest viewer telemetry for dashboards. The Tinybird admin token (`TINYBIRD_ADMIN_TOKEN` or `TINYBIRD_TOKEN`) must be available in your environment. Once the token is present you can:

- Provision the required data sources and materialized views via `pnpm analytics:setup`. This command installs the Tinybird CLI (if needed), runs `tb login` when a `.tinyb` credential file is missing, copies that credential into `scripts/analytics/tinybird`, and finally executes `tb deploy --allow-destructive-operations --wait` from that directory. **It synchronizes the Tinybird workspace to the resources defined in `scripts/analytics/tinybird`, removing any other datasources/pipes in that workspace.**
- Validate that the schema and materialized views match what the app expects via `pnpm analytics:check`.

Both commands target the workspace pointed to by `TINYBIRD_HOST` (defaults to `https://api.tinybird.co`). Make sure you are comfortable with the destructive nature of the deploy step before running `analytics:setup`.

# 编译和使用 (Chinese)

## 编译

Cap 使用 Tauri 和 Rust 构建桌面应用程序。要编译 Cap Desktop，请按照以下步骤操作：

1.  **先决条件**: 确保您已安装 Node.js, pnpm 和 Rust。
2.  **安装依赖**: 在项目根目录下运行 `pnpm install`。
3.  **准备环境**: 根据您的需要配置 `.env` 文件（参考 `.env.example`）。
4.  **开发模式**: 运行 `pnpm dev` 启动开发服务器。
5.  **构建**: 运行 `pnpm build` 构建生产版本。

## 使用 GitHub Actions 构建 Windows 应用 (推荐)

我们提供了一个简化的工作流，只需简单的几步即可在 GitHub 上自动构建 Windows 安装包。

1.  **Fork 仓库**: 点击本页面右上角的 "Fork" 按钮，将项目复刻到您的 GitHub 账户。
2.  **运行工作流**:
    *   在您 Fork 的仓库中，点击顶部的 **Actions** 标签页。
    *   在左侧列表中，选择 **Build Windows App** 工作流。
    *   点击右侧的 **Run workflow** 按钮（如果是首次运行，可能需要点击 "I understand my workflows, go ahead and enable them"）。
    *   再次点击绿色的 **Run workflow** 按钮确认。
3.  **下载安装包**:
    *   等待工作流运行完成（通常需要 15-30 分钟）。
    *   点击运行记录进入详情页。
    *   在底部的 **Artifacts** 区域，您会看到一个名为 `windows-installer` 的文件。
    *   点击下载该文件，解压后即可获得 `.exe` 安装包。

*注意：此构建方式生成的是未签名的安装包，Windows 可能会提示安全警告，您可以选择“仍要运行”。*

## 使用

1.  启动应用程序后，您可以选择录制屏幕、窗口或区域。
2.  在“设置”中，您可以配置语言（支持简体中文）、录制分辨率、帧率等选项。
3.  录制完成后，您可以编辑视频并将其上传到 Cap Web 或自托管服务器。

如需更改语言：
1.  进入“设置” (Settings)。
2.  目前语言会根据您的系统语言自动检测（如果是中文系统则显示中文）。
