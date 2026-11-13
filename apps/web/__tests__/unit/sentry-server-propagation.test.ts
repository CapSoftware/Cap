import { beforeEach, describe, expect, it, vi } from "vitest";

const init = vi.hoisted(() => vi.fn());
vi.mock("@sentry/nextjs", () => ({ init }));

describe("server Sentry setup", () => {
	beforeEach(() => {
		init.mockReset();
		vi.resetModules();
		vi.stubEnv(
			"NEXT_PUBLIC_SENTRY_DSN",
			"https://public@example.ingest.sentry.io/1",
		);
	});

	it.each([
		["node", "../../sentry.server.config"],
		["edge", "../../sentry.edge.config"],
	])(
		"adds no trace headers to outgoing requests on the %s runtime",
		async (_runtime, path) => {
			await import(path);
			expect(init).toHaveBeenCalledTimes(1);
			const options = init.mock.calls[0]?.[0];
			expect(options.tracePropagationTargets).toEqual([]);
			expect(options.tracesSampleRate).toBe(0);
		},
	);
});
