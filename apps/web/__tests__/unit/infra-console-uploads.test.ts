// @vitest-environment jsdom

import { createElement, type FunctionComponent, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InfraVideoListItem } from "@/lib/infra-video-view";
import {
	button,
	chooseFiles,
	click,
	type Deferred,
	deferred,
	flush,
	openStage,
	type Stage,
	stubStorageUploads,
	stubVideoProbe,
	text,
	until,
} from "./infra-console-harness";

const mocks = vi.hoisted(() => ({
	router: {
		refresh: vi.fn(),
		push: vi.fn(),
		replace: vi.fn(),
	},
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

const FAILURE_TEXT = /did not arrive|Upload not finished/;

const video = (
	id: string,
	state: InfraVideoListItem["state"],
	overrides: Partial<InfraVideoListItem> = {},
): InfraVideoListItem => ({
	id,
	name: id,
	externalUserId: null,
	duration: state === "ready" ? 12 : null,
	createdAt: new Date(),
	state,
	...overrides,
});

const file = (name: string, bytes = 2048) =>
	new File([new Uint8Array(bytes)], name, { type: "video/mp4" });

let stage: Stage;
let completions: Map<string, Deferred<void>>;
let apiCalls: string[];

const show = (
	videos: InfraVideoListItem[],
	props: { userId?: string; hasMore?: boolean; nextLimit?: number | null } = {},
) =>
	stage.render(
		createElement(
			Provider,
			{ appId: "a1", balanceMicroCredits: 5_000_000 },
			createElement(VideosClient, {
				appId: "a1",
				videos,
				userId: props.userId ?? "",
				hasMore: props.hasMore ?? false,
				nextLimit: props.nextLimit ?? null,
			}),
		),
	);

const rowFor = (name: string) => {
	const link = [...document.querySelectorAll("tbody a")].find(
		(candidate) => candidate.textContent === name,
	);
	const row = link?.closest("tr");
	if (!row) throw new Error(`Row not found: ${name}`);
	return row.textContent ?? "";
};

beforeEach(() => {
	stage = openStage();
	completions = new Map();
	apiCalls = [];
	let created = 0;
	stubVideoProbe();
	stubStorageUploads();
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: { body: string }) => {
			const step = url.split("/").pop() ?? "";
			const body = JSON.parse(init.body) as {
				videoId?: string;
				partNumbers?: number[];
			};
			apiCalls.push(step);
			const json = (data: unknown) =>
				new Response(JSON.stringify(data), { status: 200 });
			if (step === "create") return json({ videoId: `new-${++created}` });
			if (step === "initiate") return json({ uploadId: "upload-1" });
			if (step === "presign") {
				return json({
					parts: (body.partNumbers ?? []).map((partNumber) => ({
						partNumber,
						presignedUrl: `https://storage.example/part-${partNumber}`,
					})),
				});
			}
			if (step === "complete") {
				const gate = deferred<void>();
				completions.set(body.videoId ?? "", gate);
				await gate.promise;
				return json({ success: true });
			}
			return json({});
		}),
	);
});

afterEach(async () => {
	await stage.close();
});

describe("a video uploaded from the console", () => {
	it("never reads as a failed upload between completion and the first processing state", async () => {
		const old = video("old", "ready");
		await show([old]);

		await chooseFiles([file("talk.mp4")]);
		await until(() => mocks.router.refresh.mock.calls.length === 1, "listing");
		await show([video("new-1", "uploading"), old]);
		await until(() => completions.has("new-1"), "the completion call");

		expect(rowFor("new-1")).toContain("Uploading");
		expect(text()).toContain("Finishing");

		completions.get("new-1")?.resolve();
		await until(
			() => mocks.toast.success.mock.calls.length === 1,
			"the uploaded toast",
		);
		await flush();

		expect(mocks.toast.success).toHaveBeenCalledWith("Uploaded talk.mp4");
		expect(mocks.router.refresh).toHaveBeenCalledTimes(2);
		expect(text()).not.toContain("Finishing");
		expect(rowFor("new-1")).toContain("Processing");
		expect(text()).not.toMatch(FAILURE_TEXT);

		await show([video("new-1", "processing"), old]);
		expect(rowFor("new-1")).toContain("Processing");

		await show([video("new-1", "ready"), old]);
		expect(rowFor("new-1")).toContain("Ready");

		expect(stage.seen.length).toBeGreaterThan(0);
		expect(stage.seen.filter((frame) => FAILURE_TEXT.test(frame))).toEqual([]);
		expect(mocks.deleteVideo).not.toHaveBeenCalled();
	});

	it("keeps a finished upload out of the failed state while the next file in the queue is sending", async () => {
		await show([video("old", "ready")]);

		await chooseFiles([file("one.mp4"), file("two.mp4")]);
		await until(() => completions.has("new-1"), "the first completion call");
		await show([video("new-1", "uploading"), video("old", "ready")]);

		completions.get("new-1")?.resolve();
		await until(() => completions.has("new-2"), "the second completion call");
		await show([
			video("new-2", "uploading"),
			video("new-1", "uploading"),
			video("old", "ready"),
		]);

		expect(rowFor("new-1")).toContain("Processing");
		expect(rowFor("new-2")).toContain("Uploading");
		expect(text()).not.toMatch(FAILURE_TEXT);

		completions.get("new-2")?.resolve();
		await until(
			() => mocks.toast.success.mock.calls.length === 2,
			"both uploaded toasts",
		);
		await flush();

		expect(rowFor("new-1")).toContain("Processing");
		expect(rowFor("new-2")).toContain("Processing");
		expect(stage.seen.filter((frame) => FAILURE_TEXT.test(frame))).toEqual([]);
	});

	it("still calls an upload this tab did not send unfinished, and offers to remove it", async () => {
		await show([video("left-behind", "uploading"), video("old", "ready")]);

		expect(rowFor("left-behind")).toContain("Upload not finished");
		expect(rowFor("left-behind")).toContain(
			"The file did not arrive. Remove this and upload it again.",
		);
		expect(rowFor("old")).not.toMatch(FAILURE_TEXT);

		await click(button("Remove left-behind"));
		expect(text()).toContain("Remove upload");
		await click(button("Remove"));
		await until(() => mocks.deleteVideo.mock.calls.length === 1, "the removal");
		expect(mocks.deleteVideo).toHaveBeenCalledWith("a1", "left-behind");
	});
});

describe("a file the console cannot upload", () => {
	it("says an empty file is empty, without asking the server", async () => {
		await show([video("old", "ready")]);

		await chooseFiles([file("empty.mp4", 0)]);
		await until(() => text().includes("That file is empty."), "the message");

		expect(text()).not.toContain("This browser cannot open that file");
		expect(apiCalls).toEqual([]);
		expect(document.querySelector("[role=alert]")?.textContent).toContain(
			"That file is empty.",
		);
	});
});

describe("the videos list", () => {
	const fifty = Array.from({ length: 50 }, (_, index) =>
		video(`video-${index}`, "ready"),
	);

	it("offers the filter as soon as there is one video, with no user id on it", async () => {
		await show([video("only", "ready")]);

		expect(
			document.querySelector('input[placeholder="Filter by user id"]'),
		).not.toBeNull();
		expect(text()).toContain("Every video in this app, newest first.");
		expect(
			[...document.querySelectorAll("button")].some(
				(candidate) => candidate.textContent === "Show more",
			),
		).toBe(false);
	});

	it("reaches past the first fifty", async () => {
		await show(fifty, { hasMore: true, nextLimit: 100 });

		expect(text()).toContain("The 50 most recent, newest first.");
		await click(button("Show more"));

		expect(mocks.router.replace).toHaveBeenCalledExactlyOnceWith(
			"/dashboard/infra/a1/videos?show=100",
			{ scroll: false },
		);
	});

	it("keeps the user id filter when showing more", async () => {
		await show(fifty, { userId: "u 42", hasMore: true, nextLimit: 150 });

		await click(button("Show more"));

		expect(mocks.router.replace).toHaveBeenCalledExactlyOnceWith(
			"/dashboard/infra/a1/videos?userId=u+42&show=150",
			{ scroll: false },
		);
	});

	it("says where the list stops instead of offering more", async () => {
		await show(fifty, { hasMore: true, nextLimit: null });

		expect(text()).toContain("These are the 1,000 most recent.");
		expect(
			[...document.querySelectorAll("button")].some(
				(candidate) => candidate.textContent === "Show more",
			),
		).toBe(false);
	});
});
