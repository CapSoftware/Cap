# Changelog

## \[2.5.0]

### enhance

- [`b8056f48`](https://github.com/tauri-apps/plugins-workspace/commit/b8056f484c7144af095d4d6ded1e8adbb9b8a865) ([#2897](https://github.com/tauri-apps/plugins-workspace/pull/2897) by [@petersamokhin](https://github.com/tauri-apps/plugins-workspace/../../petersamokhin)) Allow reveal multiple items in the file explorer.

## \[2.4.0]

- [`f209b2f2`](https://github.com/tauri-apps/plugins-workspace/commit/f209b2f23cb29133c97ad5961fb46ef794dbe063) ([#2804](https://github.com/tauri-apps/plugins-workspace/pull/2804) by [@renovate](https://github.com/tauri-apps/plugins-workspace/../../renovate)) Updated tauri to 2.6

## \[2.3.1]

### feat

- [`2aec8ff4`](https://github.com/tauri-apps/plugins-workspace/commit/2aec8ff4c41d178ea9804f7b6eff343c726be015) ([#2803](https://github.com/tauri-apps/plugins-workspace/pull/2803) by [@lucasfernog](https://github.com/tauri-apps/plugins-workspace/../../lucasfernog)) Add `inAppBrowser` option to open URLs in an in-app browser on Android and iOS.

## \[2.3.0]

- [`ce9888a2`](https://github.com/tauri-apps/plugins-workspace/commit/ce9888a2d4c9b449bd2a306f0fa6c76507fd46d3) ([#2762](https://github.com/tauri-apps/plugins-workspace/pull/2762)) Similar to the `fs` plugin the `opener` plugin now supports a `requireLiteralLeadingDot` configuration in `tauri.conf.json`.

## \[2.2.7]

- [`6c9e08dc`](https://github.com/tauri-apps/plugins-workspace/commit/6c9e08dccb3ac99fccfce586fa2b69717ba81b52) ([#2695](https://github.com/tauri-apps/plugins-workspace/pull/2695) by [@ShaunSHamilton](https://github.com/tauri-apps/plugins-workspace/../../ShaunSHamilton)) Adjust `open_url` url type to allow `URL`
- [`dde6f3c3`](https://github.com/tauri-apps/plugins-workspace/commit/dde6f3c31c1b79942abb556be31757dc583f509e) ([#2549](https://github.com/tauri-apps/plugins-workspace/pull/2549) by [@renovate](https://github.com/tauri-apps/plugins-workspace/../../renovate)) Update `windows` crate to 0.61 to align with Tauri 2.5

## \[2.2.6]

- [`1a984659`](https://github.com/tauri-apps/plugins-workspace/commit/1a9846599b6a71faf330845847a30f6bf9735898) ([#2469](https://github.com/tauri-apps/plugins-workspace/pull/2469) by [@FabianLars](https://github.com/tauri-apps/plugins-workspace/../../FabianLars)) Update `objc2` crate to 0.6. No user facing changes.
- [`71f95c9f`](https://github.com/tauri-apps/plugins-workspace/commit/71f95c9f05b29cf1be586849614c0b007757c15d) ([#2445](https://github.com/tauri-apps/plugins-workspace/pull/2445) by [@renovate](https://github.com/tauri-apps/plugins-workspace/../../renovate)) Updated `windows` crate to 0.60 to match Tauri 2.3.0. No user facing changes.

## \[2.2.5]

- [`5b821181`](https://github.com/tauri-apps/plugins-workspace/commit/5b8211815825ddae2dcc0c00520e0cfdff002763) ([#2332](https://github.com/tauri-apps/plugins-workspace/pull/2332) by [@betamos](https://github.com/tauri-apps/plugins-workspace/../../betamos)) Fix broken JS commands `opener.openPath` and `opener.openUrl` on mobile.

## \[2.2.4]

- [`da5c59e2`](https://github.com/tauri-apps/plugins-workspace/commit/da5c59e2fe879d177e3cfd52fcacce85440423cb) ([#2271](https://github.com/tauri-apps/plugins-workspace/pull/2271) by [@renovate](https://github.com/tauri-apps/plugins-workspace/../../renovate)) Updated `zbus` dependency to version 5. No API changes.

## \[2.2.3]

- [`a9ac1e3c`](https://github.com/tauri-apps/plugins-workspace/commit/a9ac1e3c939cec4338a9422ef02323c1d4dde6cd) ([#2253](https://github.com/tauri-apps/plugins-workspace/pull/2253) by [@betamos](https://github.com/tauri-apps/plugins-workspace/../../betamos)) Return an error in `open_path` if the file does not exist when opening with default application.

## \[2.2.2]

- [`ee0f65de`](https://github.com/tauri-apps/plugins-workspace/commit/ee0f65de5c645c244c5f0b638e0e0aab687cb9bf) ([#2207](https://github.com/tauri-apps/plugins-workspace/pull/2207) by [@universalappfactory](https://github.com/tauri-apps/plugins-workspace/../../universalappfactory)) Fixed OpenerPlugin packagename for android

## \[2.2.1]

- [`18dffc9d`](https://github.com/tauri-apps/plugins-workspace/commit/18dffc9dfecaf0c900e233e041d9ca36c92834b5) ([#2189](https://github.com/tauri-apps/plugins-workspace/pull/2189) by [@lucasfernog](https://github.com/tauri-apps/plugins-workspace/../../lucasfernog)) Fix usage on iOS.

## \[2.2.0]

- [`3a79266b`](https://github.com/tauri-apps/plugins-workspace/commit/3a79266b8cf96a55b1ae6339d725567d45a44b1d) ([#2173](https://github.com/tauri-apps/plugins-workspace/pull/2173) by [@FabianLars](https://github.com/tauri-apps/plugins-workspace/../../FabianLars)) Bumped all plugins to `v2.2.0`. From now, the versions for the Rust and JavaScript packages of each plugin will be in sync with each other.

## \[2.0.0]

- [`383e636a`](https://github.com/tauri-apps/plugins-workspace/commit/383e636a8e595aec1300999a8aeb7d9bf8c14632) ([#2019](https://github.com/tauri-apps/plugins-workspace/pull/2019) by [@amrbashir](https://github.com/tauri-apps/plugins-workspace/../../amrbashir)) Initial Release
