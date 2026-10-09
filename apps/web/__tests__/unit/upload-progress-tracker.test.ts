// @vitest-environment jsdom

import type { Video } from "@cap/web-domain";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { UploadProgress } from "@/app/s/[videoId]/_components/upload-progress";

const mocks = vi.hoisted(() => ({
	progress: null as (() => UploadProgress | null) | null,
}));
vi.mock("@/app/s/[videoId]/_components/ProgressCircle", () => ({
	useUploadProgress: () => mocks.progress?.() ?? null,
}));

import UploadProgressTracker from "@/app/s/[videoId]/_components/UploadProgressTracker";

const videoId = "video" as Video.VideoId;
let root: Root;
let container: HTMLDivElement;
let received: (UploadProgress | null)[];
let rerenderHost: () => void;

function Host() {
	const [, setProgress] = useState<UploadProgress | null>(null);
	const [, setTick] = useState(0);
	rerenderHost = () => setTick((tick) => tick + 1);
	return createElement(UploadProgressTracker, {
		videoId,
		onChange: onChangeFor(setProgress),
	});
}

const stable = new WeakMap<object, (progress: UploadProgress | null) => void>();
function onChangeFor(set: (progress: UploadProgress | null) => void) {
	let handler = stable.get(set);
	if (!handler) {
		handler = (progress) => {
			received.push(progress);
			if (received.length > 20) throw new Error("onChange is looping");
			set(progress);
		};
		stable.set(set, handler);
	}
	return handler;
}

const uploading = (progress: number): (() => UploadProgress) => {
	const lastUpdated = 1_790_000_000_000;
	return () => ({
		status: "uploading",
		lastUpdated: new Date(lastUpdated),
		progress,
	});
};

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	received = [];
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

test("passes on a progress value once however often it is rebuilt", async () => {
	mocks.progress = uploading(40);
	await act(async () => root.render(createElement(Host)));
	for (let i = 0; i < 5; i++) await act(async () => rerenderHost());

	expect(received).toHaveLength(1);
	expect(received[0]).toMatchObject({ status: "uploading", progress: 40 });
});

test("passes on real progress and status changes", async () => {
	mocks.progress = uploading(40);
	await act(async () => root.render(createElement(Host)));

	mocks.progress = uploading(41);
	await act(async () => rerenderHost());
	const lastUpdated = new Date(1_790_000_001_000);
	mocks.progress = () => ({
		status: "processing",
		lastUpdated,
		progress: 10,
		message: null,
	});
	await act(async () => rerenderHost());
	mocks.progress = () => null;
	await act(async () => rerenderHost());

	expect(received.map((progress) => progress?.status ?? null)).toEqual([
		"uploading",
		"uploading",
		"processing",
		null,
	]);
	expect(received[1]).toMatchObject({ progress: 41 });
});
