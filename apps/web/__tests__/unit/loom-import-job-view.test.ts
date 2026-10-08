// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
	default: ({
		children,
		...props
	}: React.PropsWithChildren<Record<string, unknown>>) =>
		React.createElement("a", props, children),
}));

import {
	ROW_HEIGHT,
	VirtualImportList,
} from "@/app/(org)/dashboard/import/loom/[jobId]/import-list";
import { useLoomImportJob } from "@/app/(org)/dashboard/import/loom/[jobId]/use-loom-import-job";
import {
	type LoomImportItemView,
	type LoomImportJobStatus,
	type LoomImportSnapshot,
	summarizeLoomImportItems,
} from "@/lib/loom-import/status";

const item = (index: number, overrides: Partial<LoomImportItemView> = {}) =>
	({
		id: `item-${index}`,
		row: index + 2,
		url: `https://www.loom.com/share/${index}`,
		loomId: String(index),
		title: `Video ${index}`,
		email: null,
		space: null,
		status: "queued",
		videoId: null,
		recordedAt: null,
		duration: null,
		thumb: null,
		v: 1,
		...overrides,
	}) satisfies LoomImportItemView;

const snapshot = ({
	items,
	full,
	cursor,
	status = "importing",
	summary = full,
}: {
	items: LoomImportItemView[];
	full: boolean;
	cursor: number;
	status?: LoomImportJobStatus;
	summary?: boolean;
}): LoomImportSnapshot => ({
	job: {
		id: "job-1",
		fileName: "loom.csv",
		status,
		totalCount: 3,
		createdAt: "2026-10-07T00:00:00.000Z",
		startedAt: null,
		completedAt: null,
		createdByMe: true,
		canStart: false,
		isPro: true,
		isAdmin: true,
	},
	summary: summary ? summarizeLoomImportItems(items) : null,
	items,
	cursor,
	full,
});

type Pending = {
	url: string;
	resolve: (body: LoomImportSnapshot) => void;
};

let root: Root;
let container: HTMLDivElement;
let requests: Pending[];

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	requests = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(
			(url: string) =>
				new Promise<Response>((resolve) => {
					requests.push({
						url,
						resolve: (body) =>
							resolve({
								ok: true,
								status: 200,
								json: async () => body,
							} as Response),
					});
				}),
		),
	);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function flush() {
	await act(async () => {
		for (let index = 0; index < 10; index++) await Promise.resolve();
	});
}

describe("useLoomImportJob", () => {
	it("waits for the full load before polling and applies answers in order", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let latest: ReturnType<typeof useLoomImportJob> | undefined;
		const Harness = ({ initial }: { initial: LoomImportSnapshot }) => {
			latest = useLoomImportJob(initial, { watchForUpgrade: false });
			return null;
		};

		await act(async () => {
			root.render(
				React.createElement(Harness, {
					initial: snapshot({
						items: [item(0, { status: "ready" })],
						full: false,
						cursor: 1_000,
						status: "checking",
						summary: true,
					}),
				}),
			);
		});
		expect(requests.map((request) => request.url)).toEqual([
			"/api/import/loom/jobs?jobId=job-1",
		]);

		await act(async () => {
			vi.advanceTimersByTime(5_000);
		});
		expect(requests).toHaveLength(1);

		requests[0]?.resolve(
			snapshot({
				items: [
					item(0, { status: "ready" }),
					item(1, { status: "ready" }),
					item(2, { status: "failed" }),
				],
				full: true,
				cursor: 2_000,
				status: "checking",
			}),
		);
		await flush();
		expect(latest?.items.map((row) => row.status)).toEqual([
			"ready",
			"ready",
			"failed",
		]);
		expect(latest?.summary.counts).toMatchObject({
			ready: 2,
			failed: 1,
			total: 3,
		});

		await act(async () => {
			vi.advanceTimersByTime(4_000);
		});
		expect(requests[1]?.url).toBe(
			"/api/import/loom/jobs?jobId=job-1&since=2000",
		);
		const refresh = latest?.refresh();
		await flush();
		expect(requests).toHaveLength(2);

		requests[1]?.resolve(
			snapshot({
				items: [item(0, { status: "importing", progress: 20, v: 2 })],
				full: false,
				cursor: 3_000,
			}),
		);
		await flush();
		expect(latest?.summary.job.status).toBe("importing");
		expect(latest?.items.map((row) => row.status)).toEqual([
			"importing",
			"queued",
			"failed",
		]);
		expect(latest?.summary.counts).toMatchObject({
			importing: 1,
			queued: 1,
			failed: 1,
			total: 3,
		});
		expect(requests[2]?.url).toBe("/api/import/loom/jobs?jobId=job-1");

		requests[2]?.resolve(
			snapshot({
				items: [
					item(0, { status: "imported", v: 3 }),
					item(1, { status: "importing", v: 3 }),
					item(2, { status: "failed" }),
				],
				full: true,
				cursor: 4_000,
			}),
		);
		await act(async () => {
			await refresh;
		});
		expect(latest?.items.map((row) => row.status)).toEqual([
			"imported",
			"importing",
			"failed",
		]);
	});

	it("stops polling in a background tab and catches up when it comes back", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		let hidden = false;
		Object.defineProperty(document, "hidden", {
			configurable: true,
			get: () => hidden,
		});
		const setHidden = async (value: boolean) => {
			hidden = value;
			await act(async () => {
				document.dispatchEvent(new Event("visibilitychange"));
			});
		};
		const Harness = ({ initial }: { initial: LoomImportSnapshot }) => {
			useLoomImportJob(initial, { watchForUpgrade: false });
			return null;
		};
		try {
			await act(async () => {
				root.render(
					React.createElement(Harness, {
						initial: snapshot({
							items: [item(0, { status: "importing" })],
							full: true,
							cursor: 1_000,
						}),
					}),
				);
			});
			await act(async () => {
				vi.advanceTimersByTime(4_000);
			});
			expect(requests).toHaveLength(1);
			requests[0]?.resolve(snapshot({ items: [], full: false, cursor: 1_000 }));
			await flush();

			await setHidden(true);
			await act(async () => {
				vi.advanceTimersByTime(30 * 60_000);
			});
			expect(requests).toHaveLength(1);

			await setHidden(false);
			await flush();
			expect(requests.map((request) => request.url)).toEqual([
				"/api/import/loom/jobs?jobId=job-1&since=1000",
				"/api/import/loom/jobs?jobId=job-1",
			]);
		} finally {
			Reflect.deleteProperty(document, "hidden");
		}
	});
});

describe("VirtualImportList", () => {
	const rows = Array.from({ length: 200 }, (_, index) => item(index));
	const nextFrame = (callback: FrameRequestCallback) => {
		queueMicrotask(() => callback(0));
		return 1;
	};
	const render = async (items: LoomImportItemView[]) => {
		await act(async () => {
			root.render(
				React.createElement(VirtualImportList, {
					items,
					viewport: 640,
					showOwner: false,
					empty: "No videos match",
				}),
			);
		});
	};
	const firstRenderedRow = () =>
		container.querySelector("li")?.getAttribute("aria-posinset");

	it("shows the top of the list again after a search with no matches is cleared", async () => {
		vi.stubGlobal("requestAnimationFrame", nextFrame);
		await render(rows);
		const list = container.querySelector<HTMLElement>(
			"[data-testid=loom-import-list]",
		);
		if (!list) throw new Error("Missing list");
		await act(async () => {
			list.scrollTop = 120 * ROW_HEIGHT;
			list.dispatchEvent(new Event("scroll"));
		});
		expect(Number(firstRenderedRow())).toBeGreaterThan(100);

		await render([]);
		expect(container.textContent).toContain("No videos match");

		await render(rows);
		expect(firstRenderedRow()).toBe("1");
	});

	it("keeps rows on screen when the browser clamps the scroll after a search shrinks the list", async () => {
		vi.stubGlobal("requestAnimationFrame", nextFrame);
		await render(rows);
		const list = container.querySelector<HTMLElement>(
			"[data-testid=loom-import-list]",
		);
		if (!list) throw new Error("Missing list");
		let requested = 0;
		Object.defineProperty(list, "scrollTop", {
			configurable: true,
			get: () => {
				const content = Number.parseFloat(
					list.querySelector("ul")?.style.height ?? "0",
				);
				return Math.min(requested, Math.max(0, content - 640));
			},
			set: (value: number) => {
				requested = value;
			},
		});
		await act(async () => {
			list.scrollTop = 150 * ROW_HEIGHT;
			list.dispatchEvent(new Event("scroll"));
		});
		expect(Number(firstRenderedRow())).toBeGreaterThan(130);

		await render(rows.slice(0, 20));
		const rendered = Array.from(container.querySelectorAll("li")).map((li) =>
			Number(li.getAttribute("aria-posinset")),
		);
		expect(rendered.length).toBeGreaterThan(0);
		expect(Math.max(...rendered)).toBe(20);
	});
});
