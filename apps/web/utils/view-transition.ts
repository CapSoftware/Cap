export function navigateWithTransition(
	transitionName: string,
	navigate: () => void,
) {
	if (typeof document === "undefined") {
		navigate();
		return;
	}
	if (typeof document.startViewTransition !== "function") {
		navigate();
		return;
	}
	const html = document.documentElement;
	html.dataset.viewTransition = transitionName;
	const transition = document.startViewTransition(() => {
		navigate();
	});
	transition.finished.finally(() => {
		if (html.dataset.viewTransition === transitionName) {
			delete html.dataset.viewTransition;
		}
	});
}
