import type { JSX } from "solid-js";

export function callHandler<T, E extends Event>(
	event: E & { currentTarget: T; target: Element },
	handler: JSX.EventHandlerUnion<T, E> | undefined,
) {
	if (handler) {
		if (typeof handler === "function") {
			handler(event);
		} else {
			handler[0](handler[1], event);
		}
	}

	return event?.defaultPrevented;
}

export function composeEventHandlers<T, E extends Event = Event>(
	handlers: Array<JSX.EventHandlerUnion<T, E> | undefined>,
) {
	return (event: E & { currentTarget: T; target: Element }) => {
		for (const handler of handlers) {
			callHandler(event, handler);
		}
	};
}
