(() => {
	const ids = new WeakMap();
	let nextId = 1;
	let sequence = 0;
	let lastState = "";
	let previousPreparingIds = [];
	let firstOrdinaryVisibleAt;
	const started = performance.now();
	const deadline = started + 180_000;
	const idFor = (element) => {
		if (!ids.has(element)) ids.set(element, nextId++);
		return ids.get(element);
	};
	const describe = (canvas) => {
		const rect = canvas.getBoundingClientRect();
		let ancestorsVisible = true;
		for (let element = canvas; element; element = element.parentElement) {
			const style = getComputedStyle(element);
			if (
				style.display === "none" ||
				style.visibility !== "visible" ||
				Number(style.opacity) === 0
			) {
				ancestorsVisible = false;
				break;
			}
		}
		return {
			id: idFor(canvas),
			connected: canvas.isConnected,
			width: canvas.width,
			height: canvas.height,
			bounds: {
				x: rect.x,
				y: rect.y,
				width: rect.width,
				height: rect.height,
			},
			visible:
				ancestorsVisible &&
				canvas.width > 0 &&
				canvas.height > 0 &&
				rect.width > 0 &&
				rect.height > 0 &&
				rect.bottom > 0 &&
				rect.right > 0 &&
				rect.top < innerHeight &&
				rect.left < innerWidth,
		};
	};
	const geometry = (element) => {
		if (!element) return null;
		const rect = element.getBoundingClientRect();
		const style = getComputedStyle(element);
		return {
			id: idFor(element),
			connected: element.isConnected,
			bounds: {
				x: rect.x,
				y: rect.y,
				width: rect.width,
				height: rect.height,
			},
			inline: {
				width: element.style.width,
				height: element.style.height,
				minHeight: element.style.minHeight,
			},
			computed: {
				width: style.width,
				height: style.height,
				minHeight: style.minHeight,
				maxHeight: style.maxHeight,
				display: style.display,
				visibility: style.visibility,
				flex: style.flex,
				flexDirection: style.flexDirection,
				gap: style.gap,
				paddingTop: style.paddingTop,
				paddingBottom: style.paddingBottom,
			},
		};
	};
	const ordinaryLayout = (canvas) => {
		if (!canvas) return null;
		const ancestors = [];
		for (
			let element = canvas.parentElement;
			element && ancestors.length < 10;
			element = element.parentElement
		) {
			ancestors.push(element);
		}
		const [wrapper, visibilityLayer, container, player, card, row, layout] =
			ancestors;
		const timelineSeparator = document.querySelector(
			'[role="separator"][aria-label="Resize timeline height"]',
		);
		const timeline = timelineSeparator?.parentElement;
		const sourceStructureMatches = Boolean(
			container?.parentElement === player &&
				player?.children.length === 3 &&
				player?.children[1] === container &&
				timeline?.parentElement === layout &&
				row?.nextElementSibling === timeline,
		);
		return {
			sourceStructureMatches,
			canvas: geometry(canvas),
			ancestors: ancestors.map(geometry),
			roles: sourceStructureMatches
				? {
						wrapper: idFor(wrapper),
						visibilityLayer: idFor(visibilityLayer),
						container: idFor(container),
						player: idFor(player),
						card: idFor(card),
						row: idFor(row),
						layout: idFor(layout),
					}
				: null,
			topToolbar: sourceStructureMatches
				? geometry(container.previousElementSibling)
				: null,
			bottomToolbar: sourceStructureMatches
				? geometry(container.nextElementSibling)
				: null,
			timeline: geometry(timeline),
		};
	};
	const emit = (value) => {
		void window.__TAURI_INTERNALS__
			.invoke("plugin:event|emit", {
				event: "cap-stop-benchmark-dom",
				payload: value,
			})
			.catch(() => {});
	};
	const sample = () => {
		const now = performance.now();
		const preparing = Array.from(
			document.querySelectorAll(
				'canvas[aria-label="Recording preview while the editor prepares"]',
			),
		).map((canvas) => {
			const siblings = Array.from(canvas.parentElement.children).filter(
				(element) => element.tagName === "CANVAS",
			);
			return {
				...describe(canvas),
				role: siblings.indexOf(canvas) === 1 ? "retained" : "live",
			};
		});
		const ordinaryCanvas = document.getElementById("canvas");
		const ordinary = ordinaryCanvas ? describe(ordinaryCanvas) : null;
		const stats = window.__capFpsStats?.();
		const ordinaryRenderedVisible = Boolean(
			ordinary?.visible && stats?.renderCount > 0,
		);
		if (ordinaryRenderedVisible && firstOrdinaryVisibleAt === undefined) {
			firstOrdinaryVisibleAt = now;
		}
		const state = {
			preparing,
			ordinary,
			ordinaryLayout: ordinaryLayout(ordinaryCanvas),
			ordinaryRenderedVisible,
			documentVisibility: document.visibilityState,
			viewport: {
				width: innerWidth,
				height: innerHeight,
				dpr: devicePixelRatio,
			},
		};
		const serialized = JSON.stringify(state);
		if (serialized !== lastState) {
			const currentIds = preparing.map((canvas) => canvas.id);
			emit({
				sequence: sequence++,
				timeOriginMs: performance.timeOrigin,
				elapsedMs: now - started,
				observation: "canvas_state",
				preparingSubtreesDetached: previousPreparingIds.filter(
					(id) => !currentIds.includes(id),
				),
				state,
			});
			previousPreparingIds = currentIds;
			lastState = serialized;
		}
		if (
			now < deadline &&
			sequence < 512 &&
			(firstOrdinaryVisibleAt === undefined ||
				now - firstOrdinaryVisibleAt < 1000)
		) {
			requestAnimationFrame(sample);
		} else {
			emit({
				sequence: sequence++,
				timeOriginMs: performance.timeOrigin,
				elapsedMs: now - started,
				observation: "complete",
				reason:
					firstOrdinaryVisibleAt !== undefined
						? "ordinary_visible_settled"
						: now >= deadline
							? "deadline"
							: "observation_limit",
			});
		}
	};
	requestAnimationFrame(sample);
})();
