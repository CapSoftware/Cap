// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({
	init: vi.fn(),
	captureException: vi.fn(),
	captureRouterTransitionStart: vi.fn(),
	imports: 0,
}));

vi.mock("@sentry/nextjs", () => {
	sentry.imports++;
	return {
		init: sentry.init,
		captureException: sentry.captureException,
		captureRouterTransitionStart: sentry.captureRouterTransitionStart,
	};
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

async function loadModule(pathname: string) {
	window.history.pushState({}, "", pathname);
	vi.resetModules();
	return import("@/lib/client-sentry");
}

function raise(error: unknown) {
	// Marked handled so the test runner doesn't report the deliberate error.
	window.dispatchEvent(
		new ErrorEvent("error", { error, message: "boom", cancelable: true }),
	);
}

window.addEventListener("error", (event) => event.preventDefault());

function reject(reason: unknown) {
	const event = new Event("unhandledrejection");
	Object.assign(event, { reason });
	window.dispatchEvent(event);
}

beforeEach(() => {
	vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://key@sentry.example/1");
	sentry.init.mockClear();
	sentry.captureException.mockClear();
	sentry.captureRouterTransitionStart.mockClear();
	sentry.imports = 0;
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("client Sentry", () => {
	it("replays navigations from before the SDK loaded once it has", async () => {
		const { forwardRouterTransitionStart, loadSentry } =
			await loadModule("/s/abc/edit/studio");
		forwardRouterTransitionStart("/s/abc", "push");
		expect(sentry.captureRouterTransitionStart).not.toHaveBeenCalled();
		await loadSentry();
		forwardRouterTransitionStart("/dashboard", "push");
		expect(sentry.captureRouterTransitionStart.mock.calls).toEqual([
			["/s/abc", "push"],
			["/dashboard", "push"],
		]);
	});

	it("reports errors from before the SDK loaded once it has, exactly once", async () => {
		const { startClientSentry } = await loadModule("/dashboard/caps");
		startClientSentry();
		const early = new Error("early");
		const rejected = new Error("rejected");
		raise(early);
		reject(rejected);
		await flush();
		expect(sentry.init).toHaveBeenCalledTimes(1);
		expect(sentry.captureException).toHaveBeenCalledTimes(2);
		expect(sentry.captureException).toHaveBeenCalledWith(early, {
			mechanism: {
				type: "auto.browser.global_handlers.onerror",
				handled: false,
			},
		});
		expect(sentry.captureException).toHaveBeenCalledWith(rejected, {
			mechanism: {
				type: "auto.browser.global_handlers.onunhandledrejection",
				handled: false,
			},
		});
		// The SDK's own handlers take over from here.
		window.dispatchEvent(new ErrorEvent("error", { message: "late" }));
		await flush();
		expect(sentry.captureException).toHaveBeenCalledTimes(2);
	});

	it("waits for the studio editor's first frame before loading", async () => {
		const { startClientSentry } = await loadModule("/s/abc123/edit/studio");
		startClientSentry();
		await flush();
		expect(sentry.init).not.toHaveBeenCalled();
		window.dispatchEvent(
			new MessageEvent("message", {
				data: { kind: "cap-editor-painted", version: 1 },
				origin: "https://elsewhere.example",
			}),
		);
		await flush();
		expect(sentry.init).not.toHaveBeenCalled();
		window.dispatchEvent(
			new MessageEvent("message", {
				data: { kind: "cap-editor-painted", version: 1 },
				origin: window.location.origin,
			}),
		);
		await flush();
		expect(sentry.init).toHaveBeenCalledTimes(1);
	});

	it("loads the SDK for an explicit capture", async () => {
		const { captureClientException } = await loadModule("/s/abc123");
		const error = new Error("render failed");
		captureClientException(error);
		await flush();
		expect(sentry.init).toHaveBeenCalledTimes(1);
		expect(sentry.captureException).toHaveBeenCalledWith(error);
	});

	it("does nothing without a DSN", async () => {
		vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
		const { startClientSentry, captureClientException } =
			await loadModule("/dashboard/caps");
		startClientSentry();
		reject(new Error("ignored"));
		captureClientException(new Error("ignored"));
		await flush();
		expect(sentry.imports).toBe(0);
		expect(sentry.init).not.toHaveBeenCalled();
	});
});
