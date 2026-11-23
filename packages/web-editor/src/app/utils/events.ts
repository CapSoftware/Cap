import { createEventListenerMap } from "@solid-primitives/event-listener";
import { createSignal } from "solid-js";

export function createKeyDownSignal(
	element: HTMLElement | Window,
	key: string,
) {
	const [isDown, setDown] = createSignal(false);

	createEventListenerMap(element, {
		keydown: (e) => {
			if (e.key === key) setDown(true);
		},
		keyup: (e) => {
			if (e.key === key) setDown(false);
		},
		blur: () => {
			setDown(false);
		},
	});

	return isDown;
}
