(() => {
	let armed = true;
	let frames = 0;
	const invoke = window.__TAURI_INTERNALS__.invoke;
	globalThis.__capArmPickerBenchmark = () => {
		armed = true;
		frames = 0;
	};
	const tick = () => {
		const button = Array.from(
			document.querySelectorAll('[data-disabled="false"]'),
		).find((element) => element.textContent.includes("Start Recording"));
		if (armed && button?.getBoundingClientRect().width > 0) {
			frames += 1;
			if (frames === 2) {
				armed = false;
				void invoke("plugin:event|emit", {
					event: "cap-picker-benchmark-ready",
					payload: { navigationMs: performance.now() },
				});
			}
		} else {
			frames = 0;
		}
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
})();
