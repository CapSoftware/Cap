import { createContextProvider } from "@solid-primitives/context";
import { createSignal, type JSX, onCleanup } from "solid-js";

interface WindowChromeState {
	hideMaximize?: boolean;
	maximized?: boolean;
	onMaximize?: () => void;
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
	maximized?: boolean;
	onMaximize?: () => void;
	children?: JSX.Element;
}) {
	useWindowChrome({
		get hideMaximize() {
			return props.hideMaximize;
		},
		get maximized() {
			return props.maximized;
		},
		get onMaximize() {
			return props.onMaximize;
		},
		get items() {
			return props.children;
		},
	});

	return null;
}
