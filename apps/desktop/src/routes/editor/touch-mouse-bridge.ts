/**
 * The timeline and the preview's on-canvas handles are driven by mouse
 * events, which a touch screen only sends for a tap. Inside an element given
 * to this bridge a one-finger drag is replayed as the mouse drag it stands
 * for (so scrubbing, trimming, moving and drawing segments work), and with
 * `pinch` two fingers act like a trackpad: pinch to zoom, slide sideways to
 * scroll the timeline and up or down to scroll its tracks.
 *
 * Taps are left alone: the browser already turns those into mouse events and
 * a click. The element needs `touch-action: none` so the page doesn't pan or
 * zoom underneath (see web-layout.css).
 */

// Movement before a touch counts as a drag rather than a tap.
const DRAG_SLOP_PX = 4;
// Inverse of pinchZoomFactor in Timeline/zoom.ts: a ctrl+wheel delta of d
// scales the visible span by exp(d * 0.012).
const PINCH_RATE = 0.012;

type Point = { x: number; y: number };

function mouse(
	type: "mousedown" | "mousemove" | "mouseup",
	target: EventTarget,
	point: Point,
	buttons: number,
) {
	target.dispatchEvent(
		new MouseEvent(type, {
			bubbles: true,
			cancelable: true,
			composed: true,
			view: window,
			detail: type === "mousemove" ? 0 : 1,
			clientX: point.x,
			clientY: point.y,
			screenX: point.x + window.screenX,
			screenY: point.y + window.screenY,
			button: 0,
			buttons,
		}),
	);
}

const at = (point: Point, fallback: EventTarget) =>
	document.elementFromPoint(point.x, point.y) ?? fallback;

const pointOf = (touch: Touch): Point => ({
	x: touch.clientX,
	y: touch.clientY,
});

export function bridgeTouchToMouse(
	element: HTMLElement,
	options: { pinch?: boolean } = {},
) {
	let single: {
		id: number;
		start: Point;
		last: Point;
		target: EventTarget;
		dragging: boolean;
	} | null = null;
	let pair: { distance: number; center: Point } | null = null;
	// The element the replayed pointer is "over", so leaving it afterwards
	// clears hover state (the timeline's hover preview) as a mouse would.
	let hovered: Element | null = null;

	const leave = () => {
		const from = hovered;
		hovered = null;
		for (let node = from; node; node = node.parentElement) {
			node.dispatchEvent(new MouseEvent("mouseleave", { view: window }));
			if (node === element) break;
		}
	};

	const endDrag = () => {
		if (!single?.dragging) return;
		const point = single.last;
		const target = at(point, single.target);
		mouse("mouseup", target, point, 0);
		single.dragging = false;
	};

	const twoFingers = (touches: TouchList) => {
		const a = pointOf(touches[0]);
		const b = pointOf(touches[1]);
		return {
			distance: Math.hypot(a.x - b.x, a.y - b.y),
			center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
		};
	};

	const onStart = (event: TouchEvent) => {
		if (event.touches.length === 1) {
			const touch = event.touches[0];
			single = {
				id: touch.identifier,
				start: pointOf(touch),
				last: pointOf(touch),
				target: event.target ?? element,
				dragging: false,
			};
			pair = null;
			return;
		}
		// A second finger turns a drag into a pinch.
		endDrag();
		single = null;
		if (options.pinch && event.touches.length === 2) {
			event.preventDefault();
			pair = twoFingers(event.touches);
		}
	};

	const onMove = (event: TouchEvent) => {
		if (pair && options.pinch && event.touches.length === 2) {
			event.preventDefault();
			const next = twoFingers(event.touches);
			const target = at(next.center, element);
			// Hovering at the fingers anchors the zoom there.
			mouse("mousemove", target, next.center, 0);
			hovered = target instanceof Element ? target : null;
			const scale = next.distance / Math.max(pair.distance, 1);
			const dx = pair.center.x - next.center.x;
			const dy = pair.center.y - next.center.y;
			if (Math.abs(scale - 1) > 0.002)
				target.dispatchEvent(
					new WheelEvent("wheel", {
						bubbles: true,
						cancelable: true,
						composed: true,
						view: window,
						clientX: next.center.x,
						clientY: next.center.y,
						ctrlKey: true,
						deltaY: -Math.log(scale) / PINCH_RATE,
						deltaMode: 0,
					}),
				);
			if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 0.5)
				target.dispatchEvent(
					new WheelEvent("wheel", {
						bubbles: true,
						cancelable: true,
						composed: true,
						view: window,
						clientX: next.center.x,
						clientY: next.center.y,
						deltaX: dx,
						deltaMode: 0,
					}),
				);
			else if (Math.abs(dy) > 0.5) {
				const scroller =
					target instanceof Element
						? target.closest<HTMLElement>("[data-track-scroll]")
						: null;
				if (scroller) scroller.scrollTop += dy;
			}
			pair = next;
			return;
		}

		if (!single) return;
		const touch = Array.from(event.changedTouches).find(
			(t) => t.identifier === single?.id,
		);
		if (!touch) return;
		const point = pointOf(touch);
		single.last = point;
		if (!single.dragging) {
			if (
				Math.hypot(point.x - single.start.x, point.y - single.start.y) <
				DRAG_SLOP_PX
			)
				return;
			single.dragging = true;
			mouse("mousemove", single.target, single.start, 0);
			mouse("mousedown", single.target, single.start, 1);
		}
		event.preventDefault();
		const target = at(point, single.target);
		hovered = target instanceof Element ? target : null;
		mouse("mousemove", target, point, 1);
	};

	let tapLeave: ReturnType<typeof setTimeout> | undefined;
	const onEnd = (event: TouchEvent) => {
		if (pair) {
			if (event.touches.length < 2) {
				pair = null;
				leave();
			}
			return;
		}
		if (!single) return;
		const ended = Array.from(event.changedTouches).some(
			(t) => t.identifier === single?.id,
		);
		if (!ended) return;
		if (single.dragging) {
			event.preventDefault();
			endDrag();
			leave();
		} else {
			// The browser follows a tap with its own mouse events; once they
			// have run, the pointer "leaves" so no hover state lingers.
			hovered = at(single.last, element) as Element;
			clearTimeout(tapLeave);
			tapLeave = setTimeout(leave, 350);
		}
		single = null;
	};

	const onCancel = () => {
		endDrag();
		single = null;
		pair = null;
		leave();
	};

	element.addEventListener("touchstart", onStart, { passive: false });
	element.addEventListener("touchmove", onMove, { passive: false });
	element.addEventListener("touchend", onEnd, { passive: false });
	element.addEventListener("touchcancel", onCancel);
	return () => {
		clearTimeout(tapLeave);
		element.removeEventListener("touchstart", onStart);
		element.removeEventListener("touchmove", onMove);
		element.removeEventListener("touchend", onEnd);
		element.removeEventListener("touchcancel", onCancel);
	};
}
