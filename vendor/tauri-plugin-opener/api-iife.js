if ("__TAURI__" in window) {
	var __TAURI_PLUGIN_OPENER__ = (function (n) {
		"use strict";
		async function e(n, e = {}, r) {
			return window.__TAURI_INTERNALS__.invoke(n, e, r);
		}
		return (
			"function" == typeof SuppressedError && SuppressedError,
			(n.openPath = async function (n, r) {
				await e("plugin:opener|open_path", { path: n, with: r });
			}),
			(n.openUrl = async function (n, r) {
				await e("plugin:opener|open_url", { url: n, with: r });
			}),
			(n.revealItemInDir = async function (n) {
				return e("plugin:opener|reveal_item_in_dir", {
					paths: "string" == typeof n ? [n] : n,
				});
			}),
			n
		);
	})({});
	Object.defineProperty(window.__TAURI__, "opener", {
		value: __TAURI_PLUGIN_OPENER__,
	});
}
