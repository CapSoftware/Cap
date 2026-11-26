import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
	Sentry.init({
		dsn,
		sendDefaultPii: false,
		tracesSampleRate: 0,
		// Tracing is off, so the trace headers serve nothing on outgoing
		// requests, and some of those go to customers' own servers.
		tracePropagationTargets: [],
		maxBreadcrumbs: 30,
	});
}
