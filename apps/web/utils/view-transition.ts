const NEXT_PAGE_TIMEOUT_MS = 1500;

let finishPending: (() => void) | null = null;

/**
 * Runs a navigation inside a view transition. With `waitForNextPage`, the
 * transition holds the old page until the new one calls `nextPageReady`, so
 * shared elements morph into the page that's actually there.
 */
export function navigateWithTransition(
	transitionName: string,
	navigate: () => void,
	{ waitForNextPage = false }: { waitForNextPage?: boolean } = {},
) {
	if (
		typeof document === "undefined" ||
		typeof document.startViewTransition !== "function"
	) {
		navigate();
		return;
	}
	const html = document.documentElement;
	html.dataset.viewTransition = transitionName;
	const transition = document.startViewTransition(() => {
		if (!waitForNextPage) {
			navigate();
			return;
		}
		return new Promise<void>((resolve) => {
			const finish = () => {
				if (finishPending === finish) finishPending = null;
				resolve();
			};
			finishPending?.();
			finishPending = finish;
			setTimeout(finish, NEXT_PAGE_TIMEOUT_MS);
			navigate();
		});
	});
	transition.finished.finally(() => {
		if (html.dataset.viewTransition === transitionName) {
			delete html.dataset.viewTransition;
		}
	});
}

export function nextPageReady() {
	finishPending?.();
}
