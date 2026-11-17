import { type Client, type Event, eventFiltersIntegration } from "@sentry/core";
import { afterAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({
	init: mocks.init,
	captureRouterTransitionStart: vi.fn(),
}));

vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://public@sentry.example.com/1");
await import("../../instrumentation-client");
const options = mocks.init.mock.calls[0]?.[0];
afterAll(() => vi.unstubAllEnvs());

function filter(filename: string, message = "Failed to connect to MetaMask") {
	const event: Event = {
		exception: {
			values: [
				{
					type: "Error",
					value: message,
					stacktrace: { frames: [{ filename, lineno: 7 }] },
				},
			],
		},
	};
	return eventFiltersIntegration().processEvent?.(event, {}, {
		getOptions: () => options,
	} as Client);
}

describe("Sentry browser extension filtering", () => {
	it.each(["chrome", "moz", "safari", "safari-web"])(
		"drops errors originating in %s extensions",
		(scheme) => {
			expect(filter(`${scheme}-extension://extension/scripts/inpage.js`)).toBe(
				null,
			);
		},
	);

	it.each(["Load failed", "La", "Failed to connect to MetaMask"])(
		"retains application errors named %s",
		(message) => {
			expect(filter("https://cap.so/_next/static/chunk.js", message)).not.toBe(
				null,
			);
		},
	);

	it("retains unknown sources instead of guessing from the message", () => {
		expect(filter("app:///assets/js/content.js")).not.toBe(null);
	});
});
