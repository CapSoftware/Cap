import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
	Sentry.init({
		dsn,
		sendDefaultPii: false,
		tracesSampleRate: 0,
		replaysSessionSampleRate: 0,
		replaysOnErrorSampleRate: 0,
		maxBreadcrumbs: 30,
		integrations: (integrations) =>
			integrations.filter(
				({ name }) => name !== "BrowserTracing" && name !== "BrowserSession",
			),
	});
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
