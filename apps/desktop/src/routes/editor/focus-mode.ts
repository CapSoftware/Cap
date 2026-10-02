import { createEventListener } from "@solid-primitives/event-listener";
import { type Accessor, createSignal, onCleanup } from "solid-js";

type FullscreenDocument = Document & {
	webkitFullscreenElement?: Element | null;
	webkitFullscreenEnabled?: boolean;
	webkitExitFullscreen?: () => Promise<void> | void;
};

type FullscreenTarget = HTMLElement & {
	webkitRequestFullscreen?: () => Promise<void> | void;
};

const fullscreenDocument = () => document as FullscreenDocument;

const fullscreenElement = () =>
	fullscreenDocument().fullscreenElement ??
	fullscreenDocument().webkitFullscreenElement ??
	null;

const fullscreenAvailable = () => {
	const doc = fullscreenDocument();
	const root = document.documentElement as FullscreenTarget;
	return (
		(doc.fullscreenEnabled === true && !!root.requestFullscreen) ||
		(doc.webkitFullscreenEnabled === true && !!root.webkitRequestFullscreen)
	);
};

export type FocusMode = {
	active: Accessor<boolean>;
	/** True while focus mode fills the screen; false for the in-page fallback. */
	fullscreen: Accessor<boolean>;
	toggle: () => void;
	exit: () => void;
	/** Runs just before the layout changes, so the preview can note where it was. */
	onBeforeChange: (callback: () => void) => void;
};

export function createFocusMode(): FocusMode {
	const [active, setActive] = createSignal(false);
	const [fullscreen, setFullscreen] = createSignal(false);
	const beforeChange = new Set<() => void>();
	let changing = false;
	// A request to leave that arrives mid-change runs once the change settles.
	let exitQueued = false;

	const notifyBeforeChange = () => {
		for (const callback of beforeChange) callback();
	};

	// The embedding page hears about a change once it has settled, so its bar
	// doesn't step aside for a moment while the browser goes fullscreen.
	const announce = () => {
		if (window.parent === window) return;
		window.parent.postMessage(
			{
				kind: "cap-editor-focus",
				version: 1,
				active: active(),
				fullscreen: fullscreen(),
			},
			window.location.origin,
		);
	};

	const settle = (pending: Promise<void> | void | undefined) => {
		void Promise.resolve(pending)
			.catch(() => undefined)
			.then(() => {
				changing = false;
				setFullscreen(fullscreenElement() !== null);
				announce();
				if (exitQueued) {
					exitQueued = false;
					exit();
				}
			});
	};

	// The layout changes first, inside the click or key press, and the
	// fullscreen request follows in the same turn so the browser still counts
	// it as the user's gesture. A refused request (no gesture, or a page that
	// forbids it) leaves the in-page layout, which works on its own.
	const enter = () => {
		if (active() || changing) return;
		changing = true;
		notifyBeforeChange();
		setActive(true);
		let pending: Promise<void> | void | undefined;
		if (fullscreenAvailable()) {
			const root = document.documentElement as FullscreenTarget;
			try {
				pending = root.requestFullscreen
					? root.requestFullscreen({ navigationUI: "hide" })
					: root.webkitRequestFullscreen?.();
			} catch {}
		}
		settle(pending);
	};

	const exit = () => {
		if (!active()) return;
		if (changing) {
			exitQueued = true;
			return;
		}
		changing = true;
		notifyBeforeChange();
		setActive(false);
		let pending: Promise<void> | void | undefined;
		if (fullscreenElement()) {
			const doc = fullscreenDocument();
			try {
				pending = doc.exitFullscreen
					? doc.exitFullscreen()
					: doc.webkitExitFullscreen?.();
			} catch {}
		}
		settle(pending);
	};

	// The browser leaves fullscreen on its own when Esc is pressed (the page
	// never sees that key) or the tab is switched; focus mode follows it out.
	const onFullscreenChange = () => {
		const inFullscreen = fullscreenElement() !== null;
		if (changing) {
			if (!inFullscreen && active()) exitQueued = true;
			return;
		}
		if (inFullscreen) {
			setFullscreen(true);
			announce();
			return;
		}
		if (!active() || !fullscreen()) return;
		notifyBeforeChange();
		setFullscreen(false);
		setActive(false);
		announce();
	};
	createEventListener(document, "fullscreenchange", onFullscreenChange);
	createEventListener(document, "webkitfullscreenchange", onFullscreenChange);

	onCleanup(() => {
		if (!active()) return;
		const doc = fullscreenDocument();
		if (fullscreenElement())
			void Promise.resolve(
				doc.exitFullscreen
					? doc.exitFullscreen()
					: doc.webkitExitFullscreen?.(),
			).catch(() => undefined);
		setActive(false);
		setFullscreen(false);
		announce();
	});

	return {
		active,
		fullscreen,
		toggle: () => (active() ? exit() : enter()),
		exit,
		onBeforeChange: (callback) => {
			beforeChange.add(callback);
			onCleanup(() => beforeChange.delete(callback));
		},
	};
}
