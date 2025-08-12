import { createContextProvider } from "@solid-primitives/context";
import { createSignal, type JSX, onCleanup } from "solid-js";

interface WindowChromeState {
	hideMaximize?: boolean;
	items?: JSX.Element;
}

export const [WindowChromeContext, useWindowChromeContext] =
	createContextProvider(() => {
		const [state, setState] = createSignal<WindowChromeState>();

		return { state, setState };
	});

export function useWindowChrome(state: WindowChromeState) {
	const ctx = useWindowChromeContext();
	if (!ctx)
		throw new Error(
			"useWindowChrome must be used within a WindowChromeContext",
		);

	ctx.setState?.(state);
	onCleanup(() => {
		ctx.setState?.();
	});
}

export function WindowChromeHeader(props: {
	hideMaximize?: boolean;
	children?: JSX.Element;
}) {
	useWindowChrome({
		hideMaximize: props.hideMaximize,
		get items() {
			return props.children;
		},
	});

	return null;
}
