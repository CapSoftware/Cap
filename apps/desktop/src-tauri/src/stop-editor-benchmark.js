(() => {
	let reported = false;
	const report = () => {
		if (reported) return;
		reported = true;
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				void window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
					event: "cap-stop-benchmark-frame",
					payload: {},
				});
			});
		});
	};
	const deadline = performance.now() + 180_000;
	const observe = () => {
		const canvas = document.getElementById("canvas");
		const stats = window.__capFpsStats?.();
		if (
			stats?.renderCount > 0 &&
			canvas?.width > 0 &&
			getComputedStyle(canvas).visibility === "visible"
		) {
			report();
		} else if (performance.now() < deadline) {
			requestAnimationFrame(observe);
		}
	};
	requestAnimationFrame(observe);
})();
