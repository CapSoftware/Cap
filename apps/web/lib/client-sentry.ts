type SentryModule = typeof import("@sentry/nextjs");
type GlobalErrorType = "onerror" | "onunhandledrejection";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
const MAX_EARLY_ERRORS = 30;
// The studio editor competes with its own renderer and media for the network
// until its first frame, so the SDK waits for that there. On a very slow
// connection the frame can take longer than this, which is only a backstop.
const EDITOR_PAINT_WAIT_MS = 60_000;

const earlyErrors: Array<{ error: unknown; type: GlobalErrorType }> = [];
const earlyTransitions: Array<[href: string, navigationType: string]> = [];
let loading: Promise<SentryModule | null> | null = null;
let loaded: SentryModule | null = null;

const keepEarlyError = (error: unknown, type: GlobalErrorType) => {
	if (earlyErrors.length < MAX_EARLY_ERRORS) earlyErrors.push({ error, type });
	void loadSentry();
};
const onEarlyError = (event: ErrorEvent) =>
	keepEarlyError(event.error ?? event.message, "onerror");
const onEarlyRejection = (event: PromiseRejectionEvent) =>
	keepEarlyError(event.reason, "onunhandledrejection");

export function loadSentry(): Promise<SentryModule | null> {
	if (!dsn || typeof window === "undefined") return Promise.resolve(null);
	loading ??= import("@sentry/nextjs").then(
		(Sentry) => {
			Sentry.init({
				dsn,
				sendDefaultPii: false,
				tracesSampleRate: 0,
				replaysSessionSampleRate: 0,
				replaysOnErrorSampleRate: 0,
				maxBreadcrumbs: 30,
				integrations: (integrations) =>
					integrations.filter(
						({ name }) =>
							name !== "BrowserTracing" && name !== "BrowserSession",
					),
			});
			// Sentry's own handlers are installed now; anything that failed before
			// is replayed once, the way they would have reported it.
			window.removeEventListener("error", onEarlyError);
			window.removeEventListener("unhandledrejection", onEarlyRejection);
			for (const { error, type } of earlyErrors.splice(0)) {
				Sentry.captureException(error, {
					mechanism: {
						type: `auto.browser.global_handlers.${type}`,
						handled: false,
					},
				});
			}
			for (const [href, navigationType] of earlyTransitions.splice(0)) {
				Sentry.captureRouterTransitionStart(href, navigationType);
			}
			loaded = Sentry;
			return Sentry;
		},
		() => {
			// A failed chunk load leaves the early handlers queueing, and the
			// next error or capture tries again.
			loading = null;
			return null;
		},
	);
	return loading;
}

export function captureClientException(error: unknown) {
	if (loaded) {
		loaded.captureException(error);
		return;
	}
	void loadSentry().then((Sentry) => Sentry?.captureException(error));
}

export function forwardRouterTransitionStart(
	href: string,
	navigationType: string,
) {
	if (loaded) {
		loaded.captureRouterTransitionStart(href, navigationType);
		return;
	}
	if (dsn && earlyTransitions.length < MAX_EARLY_ERRORS) {
		earlyTransitions.push([href, navigationType]);
	}
}

const whenIdle = (callback: () => void) => {
	if (typeof window.requestIdleCallback === "function")
		window.requestIdleCallback(callback, { timeout: 3000 });
	else window.setTimeout(callback, 1);
};

const isStudioEditor = (pathname: string) =>
	/^\/s\/[^/]+\/edit\/studio\/?$/.test(pathname);

/**
 * Keeps the Sentry SDK off the critical path: errors are caught from the
 * start and handed over once it loads after the page (and, in the studio
 * editor, its first frame), or right away when something fails first.
 */
export function startClientSentry() {
	if (!dsn || typeof window === "undefined") return;
	window.addEventListener("error", onEarlyError);
	window.addEventListener("unhandledrejection", onEarlyRejection);
	const load = () => whenIdle(() => void loadSentry());
	const afterPageLoad = (next: () => void) => {
		if (document.readyState === "complete") next();
		else window.addEventListener("load", next, { once: true });
	};
	if (!isStudioEditor(window.location.pathname)) {
		afterPageLoad(load);
		return;
	}
	let started = false;
	const start = () => {
		if (started) return;
		started = true;
		window.removeEventListener("message", onEditorMessage);
		load();
	};
	const onEditorMessage = (event: MessageEvent<unknown>) => {
		const data = event.data;
		if (
			event.origin === window.location.origin &&
			typeof data === "object" &&
			data !== null &&
			"kind" in data &&
			(data.kind === "cap-editor-painted" ||
				data.kind === "cap-editor-preview-failed")
		)
			start();
	};
	window.addEventListener("message", onEditorMessage);
	window.setTimeout(start, EDITOR_PAINT_WAIT_MS);
}
