!(function () {
	"use strict";
	"function" == typeof SuppressedError && SuppressedError,
		window.addEventListener("click", function (e) {
			if (e.defaultPrevented || 0 !== e.button || e.metaKey || e.altKey) return;
			const t = e
				.composedPath()
				.find((e) => e instanceof Node && "A" === e.nodeName.toUpperCase());
			if (!t || !t.href || ("_blank" !== t.target && !e.ctrlKey && !e.shiftKey))
				return;
			const n = new URL(t.href);
			n.origin === window.location.origin ||
				["http:", "https:", "mailto:", "tel:"].every((e) => n.protocol !== e) ||
				(e.preventDefault(),
				(async function (e, t = {}, n) {
					window.__TAURI_INTERNALS__.invoke(e, t, n);
				})("plugin:opener|open_url", { url: n }));
		});
})();
