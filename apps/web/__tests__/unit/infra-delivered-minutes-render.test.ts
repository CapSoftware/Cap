// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cap/database", () => ({ db: () => ({}) }));

import {
	DeliveredMinutes,
	NO_DELIVERY,
} from "@/app/(infra)/dashboard/infra/_components/delivered-minutes";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

const rows = () =>
	Array.from(container.querySelectorAll("tbody tr")).map((tr) =>
		Array.from(tr.querySelectorAll("td")).map((td) => td.textContent),
	);

describe("Delivered minutes on the Usage page", () => {
	it("says what it is and that it is not billed", () => {
		act(() =>
			root.render(
				createElement(DeliveredMinutes, {
					delivery: null,
					monthName: "November",
				}),
			),
		);

		expect(container.textContent).toContain("Delivered minutes");
		expect(container.textContent).toContain(
			"How much video your viewers watched. Not billed.",
		);
	});

	it("shows one quiet line when nothing has been measured", () => {
		act(() =>
			root.render(
				createElement(DeliveredMinutes, {
					delivery: null,
					monthName: "November",
				}),
			),
		);

		expect(container.textContent).toContain(NO_DELIVERY);
		expect(container.querySelector("table")).toBeNull();
		expect(container.textContent).not.toMatch(/\$/);
	});

	it("shows the minutes for each resolution with any delivery and a total", () => {
		act(() =>
			root.render(
				createElement(DeliveredMinutes, {
					delivery: {
						minutes: 1248.5,
						minutesByTier: {
							"360p": 12.5,
							"720p": 336,
							"1080p": 900,
							"1440p": 0,
							"2160p": 0,
						},
						measured: true,
						billed: false,
					},
					monthName: "November",
				}),
			),
		);

		expect(container.querySelector("thead")?.textContent).toBe(
			"ResolutionMinutes in November",
		);
		expect(rows()).toEqual([
			["360p", "13"],
			["720p", "336"],
			["1080p", "900"],
			["Total", "1,249"],
		]);
		expect(container.textContent).not.toContain(NO_DELIVERY);
		expect(container.textContent).not.toMatch(/\$|cost|price/i);
	});
});
