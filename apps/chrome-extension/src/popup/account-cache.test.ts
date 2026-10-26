// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_KEY } from "../shared/storage";

vi.mock("react-dom/client", async (importOriginal) => {
	const actual = await importOriginal<{ createRoot: typeof createRoot }>();
	return { createRoot: vi.fn(actual.createRoot) };
});

let stored: Record<string, unknown>;

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	stored = {
		"cap-extension-bootstrap-cache": {
			bootstrap: {
				user: { id: "old-account", email: "old@example.invalid" },
				organization: { id: "old-organization", name: "Old organization" },
				plan: { isPro: true, maxRecordingSeconds: null },
			},
			cachedAt: Date.now(),
		},
	};
	vi.stubGlobal("chrome", {
		storage: {
			local: {
				get: (keys: string[], callback: (items: object) => void) => {
					callback(
						Object.fromEntries(
							keys
								.filter((key) => key in stored)
								.map((key) => [key, stored[key]]),
						),
					);
				},
			},
			onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
		},
		runtime: {
			sendMessage: (
				message: { type: string },
				callback: (response: object) => void,
			) => {
				callback(
					message.type === "bootstrap"
						? { ok: false, error: "Network unavailable" }
						: { ok: true, cameraDevices: [], microphoneDevices: [] },
				);
			},
			onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
		},
	});
	document.body.innerHTML = '<div id="root"></div>';
});

afterEach(async () => {
	const root = vi.mocked(createRoot).mock.results[0]?.value;
	if (root) await act(async () => root.unmount());
	document.body.replaceChildren();
	vi.unstubAllGlobals();
});

describe("popup account cache", () => {
	it.each([
		{ userId: "old-account", plan: "Pro" },
		{ userId: "new-account", plan: "Free" },
	])(
		"shows $plan for $userId when bootstrap fails",
		async ({ userId, plan }) => {
			stored[AUTH_KEY] = { userId, authApiKey: "fixture-key" };
			await act(async () => {
				await import("./main");
			});

			expect(document.body.textContent).toContain("Network unavailable");
			expect(document.body.textContent).toContain(plan);
			if (plan === "Free")
				expect(document.body.textContent).not.toContain("Pro");
		},
		15_000,
	);
});
