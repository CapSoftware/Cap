// @vitest-environment jsdom

import { createElement, type FunctionComponent, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InfraVideoListItem } from "@/lib/infra-video-view";
import {
	chooseFiles,
	flush,
	openStage,
	type Stage,
	stubVideoProbe,
	text,
	until,
} from "./infra-console-harness";

const PART_BYTES = 1024;

const mocks = vi.hoisted(() => ({
	router: { refresh: vi.fn(), push: vi.fn(), replace: vi.fn() },
	toast: { success: vi.fn(), error: vi.fn() },
	deleteVideo: vi.fn(async () => undefined),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => mocks.router,
	usePathname: () => "/dashboard/infra/a1/videos",
}));
vi.mock("next/link", () => ({
	default: ({
		href,
		children,
		className,
	}: {
		href: string;
		children: ReactNode;
		className?: string;
	}) => createElement("a", { href, className }, children),
}));
vi.mock("next/font/google", () => ({
	Geist: () => ({ variable: "sans" }),
	Geist_Mono: () => ({ variable: "mono" }),
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/actions/developers/delete-video", () => ({
	deleteDeveloperVideo: mocks.deleteVideo,
}));
vi.mock("@/lib/infra-upload", async (original) => ({
	...(await original<typeof import("@/lib/infra-upload")>()),
	partBytesFor: () => PART_BYTES,
}));

const { UploadsProvider } = await import(
	"@/app/(infra)/dashboard/infra/_components/uploads"
);
const { VideosClient } = await import(
	"@/app/(infra)/dashboard/infra/[appId]/videos/videos-client"
);

const Provider = UploadsProvider as FunctionComponent<{
	appId: string;
	balanceMicroCredits: number;
}>;

const video = (
	id: string,
	state: InfraVideoListItem["state"],
): InfraVideoListItem => ({
	id,
	name: id,
	externalUserId: null,
	duration: null,
	createdAt: new Date(),
	state,
});

type Pending = {
	part: number;
	report: (loaded: number) => void;
	finish: () => void;
	fail: () => void;
};

let stage: Stage;
let presignCalls: number[][];
let completeBodies: { parts: { partNumber: number; etag: string }[] }[];
let pending: Pending[];
let inFlight: number;
let maxInFlight: number;
let failParts: Map<number, number>;
let aborted: number;

function stubStorage() {
	class FakeXhr {
		status = 200;
		upload: { onprogress: ((event: { loaded: number }) => void) | null } = {
			onprogress: null,
		};
		onload: (() => void) | null = null;
		onerror: (() => void) | null = null;
		onabort: (() => void) | null = null;
		part = 0;
		done = false;
		open(_method: string, url: string) {
			this.part = Number(url.split("part-").pop());
		}
		send(body: Blob) {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			const settle = () => {
				if (this.done) return false;
				this.done = true;
				inFlight--;
				return true;
			};
			pending.push({
				part: this.part,
				report: (loaded) => this.upload.onprogress?.({ loaded }),
				finish: () => {
					if (!settle()) return;
					this.upload.onprogress?.({ loaded: body.size });
					this.status = 200;
					this.onload?.();
				},
				fail: () => {
					if (!settle()) return;
					this.onerror?.();
				},
			});
		}
		abort() {
			if (this.done) return;
			this.done = true;
			inFlight--;
			aborted++;
			this.onabort?.();
		}
		getResponseHeader(name: string) {
			return name === "ETag" ? `"etag-${this.part}"` : null;
		}
	}
	vi.stubGlobal("XMLHttpRequest", FakeXhr);
}

async function drain() {
	for (let round = 0; round < 200; round++) {
		await flush(5);
		const batch = pending.splice(0);
		if (batch.length === 0) return;
		for (const request of batch) {
			const left = failParts.get(request.part) ?? 0;
			if (left > 0) {
				failParts.set(request.part, left - 1);
				request.fail();
			} else {
				request.finish();
			}
		}
	}
}

const show = () =>
	stage.render(
		createElement(
			Provider,
			{ appId: "a1", balanceMicroCredits: 5_000_000 },
			createElement(VideosClient, {
				appId: "a1",
				videos: [video("old", "ready")],
				userId: "",
				hasMore: false,
				nextLimit: null,
			}),
		),
	);

const file = (bytes: number) =>
	new File([new Uint8Array(bytes)], "talk.mp4", { type: "video/mp4" });

beforeEach(() => {
	stage = openStage();
	presignCalls = [];
	completeBodies = [];
	pending = [];
	inFlight = 0;
	maxInFlight = 0;
	failParts = new Map();
	aborted = 0;
	stubVideoProbe();
	stubStorage();
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: { body: string }) => {
			const step = url.split("/").pop() ?? "";
			const body = JSON.parse(init.body);
			const json = (data: unknown) =>
				new Response(JSON.stringify(data), { status: 200 });
			if (step === "create") return json({ videoId: "new-1" });
			if (step === "initiate") return json({ uploadId: "upload-1" });
			if (step === "presign") {
				presignCalls.push(body.partNumbers);
				return json({
					parts: (body.partNumbers as number[]).map((partNumber) => ({
						partNumber,
						presignedUrl: `https://storage.example/part-${partNumber}`,
					})),
				});
			}
			if (step === "complete") {
				completeBodies.push(body);
				return json({ success: true });
			}
			return json({});
		}),
	);
});

afterEach(async () => {
	vi.useRealTimers();
	await stage.close();
});

describe("console upload parts", () => {
	it("sends six parts at once and completes with every part in order", async () => {
		await show();
		await chooseFiles([file(PART_BYTES * 25 + 7)]);
		await until(() => pending.length === 6, "six parts in flight");
		await flush(20);
		expect(pending.length).toBe(6);
		expect(
			pending.map((request) => request.part).sort((a, b) => a - b),
		).toEqual([1, 2, 3, 4, 5, 6]);

		await drain();
		await until(() => completeBodies.length === 1, "the completion call");

		expect(maxInFlight).toBe(6);
		const parts = completeBodies[0]?.parts ?? [];
		expect(parts.map((part) => part.partNumber)).toEqual(
			Array.from({ length: 26 }, (_, index) => index + 1),
		);
		expect(parts.map((part) => part.etag)).toEqual(
			Array.from({ length: 26 }, (_, index) => `"etag-${index + 1}"`),
		);
		expect(presignCalls).toEqual([
			Array.from({ length: 20 }, (_, index) => index + 1),
			Array.from({ length: 6 }, (_, index) => index + 21),
		]);
	});

	it("sends a single-part file as one part", async () => {
		await show();
		await chooseFiles([file(100)]);
		await until(() => pending.length === 1, "the part in flight");
		await drain();
		await until(() => completeBodies.length === 1, "the completion call");
		expect(maxInFlight).toBe(1);
		expect(completeBodies[0]?.parts.map((part) => part.partNumber)).toEqual([
			1,
		]);
	});

	it("tries a failed part again with a fresh link and still completes", async () => {
		failParts.set(3, 1);
		await show();
		await chooseFiles([file(PART_BYTES * 8)]);
		await until(() => pending.length === 6, "six parts in flight");
		await drain();
		await flush(1100);
		await drain();
		await until(() => completeBodies.length === 1, "the completion call");
		expect(completeBodies[0]?.parts.map((part) => part.partNumber)).toEqual([
			1, 2, 3, 4, 5, 6, 7, 8,
		]);
		expect(presignCalls.length).toBe(2);
		expect(presignCalls[1]?.[0]).toBe(3);
	});

	it("shows the bytes of every part in flight together, and drops a failed part's bytes", async () => {
		await show();
		await chooseFiles([file(PART_BYTES * 10)]);
		await until(() => pending.length === 6, "six parts in flight");
		for (const request of pending) request.report(PART_BYTES / 2);
		await flush(20);
		expect(text()).toContain("30%");

		const first = pending.find((request) => request.part === 1) as Pending;
		pending.splice(pending.indexOf(first), 1);
		first.fail();
		await flush(20);
		expect(text()).toContain("25%");

		pending[0]?.report(PART_BYTES);
		await flush(20);
		expect(text()).toContain("30%");
	});

	it("stops every other part when one fails for good, and never completes", async () => {
		await show();
		await chooseFiles([file(PART_BYTES * 30)]);
		await until(() => pending.length === 6, "six parts in flight");
		const failPartTwo = () => {
			const request = pending.find((candidate) => candidate.part === 2);
			if (!request) throw new Error("part 2 is not in flight");
			pending.splice(pending.indexOf(request), 1);
			request.fail();
		};
		failPartTwo();
		await flush(1100);
		failPartTwo();
		await flush(2100);
		failPartTwo();
		await until(() => aborted === 5, "the other parts stopped");
		await flush(50);

		expect(completeBodies).toEqual([]);
		expect(inFlight).toBe(0);
		expect(text()).toMatch(/could not reach storage/);
	});
});
