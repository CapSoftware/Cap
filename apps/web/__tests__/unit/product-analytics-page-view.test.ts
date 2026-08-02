// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { ProductAnalyticsPageView } from "@/app/Layout/ProductAnalyticsPageView";

vi.mock("next/navigation", () => ({
	usePathname: () => "/",
	useSearchParams: () => new URLSearchParams(window.location.search),
}));

const actEnvironment = globalThis as typeof globalThis & {
	IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("ProductAnalyticsPageView", () => {
	beforeAll(() => {
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	});

	afterEach(() => {
		vi.useRealTimers();
		document.body.replaceChildren();
		window.localStorage?.clear();
	});

	afterAll(() => {
		delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
	});

	it("delivers a page view with campaign attribution", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-02T00:42:10.000Z"));
		window.history.replaceState(
			null,
			"",
			"/?utm_source=staging-browser&utm_medium=e2e",
		);
		const requests: Array<{
			events: Array<{
				eventId: string;
				eventName: string;
				properties?: Record<string, unknown>;
			}>;
		}> = [];
		const keepaliveValues: boolean[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				const payload = JSON.parse(
					String(init?.body),
				) as (typeof requests)[number];
				requests.push(payload);
				keepaliveValues.push(init?.keepalive === true);
				return new Response(
					JSON.stringify({
						acceptedEventIds: payload.events.map((event) => event.eventId),
						rejectedEventIds: [],
					}),
					{
						status: 202,
						headers: { "Content-Type": "application/json" },
					},
				);
			}),
		);

		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => {
			root.render(createElement(ProductAnalyticsPageView));
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});

		expect(requests).toHaveLength(1);
		expect(keepaliveValues).toEqual([true]);
		expect(requests[0]?.events).toHaveLength(1);
		expect(requests[0]?.events[0]).toMatchObject({
			eventName: "page_view",
			properties: {
				first_touch_source: "staging-browser",
				first_touch_medium: "e2e",
				session_touch_source: "staging-browser",
				session_touch_medium: "e2e",
				last_touch_source: "staging-browser",
				last_touch_medium: "e2e",
				is_session_entry: true,
			},
		});

		await act(async () => {
			root.unmount();
		});
	});
});
