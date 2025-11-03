import { createEventListenerMap } from "@solid-primitives/event-listener";
import type { UseQueryResult } from "@tanstack/solid-query";
import { createSignal, onCleanup, onMount } from "solid-js";
import { events } from "./tauri";

export function createQueryInvalidate<T extends UseQueryResult>(
	query: T,
	event: keyof typeof events,
) {
	onMount(() => {
		const cleanup = events[event].listen(() => query.refetch());
		onCleanup(() => cleanup.then((c) => c()));
	});
}

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
