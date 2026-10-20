// @vitest-environment jsdom

import { act, type ComponentProps, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getRecordingOwnershipTransfer,
	prepareRecordingOwnershipPreflight,
	previewRecordingOwnershipTransfer,
	retryRecordingOwnershipTransfer,
	rollbackRecordingOwnershipTransfer,
	startRecordingOwnershipTransfer,
} from "@/actions/organization/recording-ownership-transfer";
import { RecordingOwnership } from "@/app/(org)/dashboard/settings/organization/content/recording-ownership/RecordingOwnership";

vi.mock("@/actions/organization/recording-ownership-transfer", () => ({
	getRecordingOwnershipTransfer: vi.fn(),
	prepareRecordingOwnershipPreflight: vi.fn(),
	previewRecordingOwnershipTransfer: vi.fn(),
	retryRecordingOwnershipTransfer: vi.fn(),
	rollbackRecordingOwnershipTransfer: vi.fn(),
	startRecordingOwnershipTransfer: vi.fn(),
}));
vi.mock("@cap/ui", () => {
	const container = ({ children }: { children?: ReactNode }) =>
		createElement("div", null, children);
	return {
		Button: (props: ComponentProps<"button">) =>
			createElement("button", { ...props, type: props.type ?? "button" }),
		Input: (props: ComponentProps<"input">) => createElement("input", props),
		Card: container,
		CardHeader: container,
		CardTitle: container,
	};
});

let root: Root;
let container: HTMLDivElement;
const actEnvironment = globalThis as typeof globalThis & {
	IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const request = {
	videoId: "test-video",
	targetUserId: "test-target",
	destinationFolderId: null,
};

function button(text: string) {
	const found = Array.from(container.querySelectorAll("button")).find(
		(element) => element.textContent === text,
	);
	if (!found) throw new Error("Missing synthetic test control");
	return found;
}

function input(label: string) {
	const found = Array.from(container.querySelectorAll("label")).find(
		(element) => element.textContent === label,
	);
	const element = document.getElementById(found?.htmlFor ?? "");
	if (!(element instanceof HTMLInputElement))
		throw new Error("Missing synthetic test input");
	return element;
}

async function fill(label: string, value: string) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set?.call(input(label), value);
		input(label).dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function click(text: string) {
	await act(async () => button(text).click());
}

async function ready() {
	await fill("Recording ID", request.videoId);
	await fill("Destination member ID", request.targetUserId);
	await click("Check transfer (read only)");
	await act(async () =>
		container.querySelector<HTMLInputElement>("[type=checkbox]")?.click(),
	);
}

beforeEach(async () => {
	actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	vi.resetAllMocks();
	vi.mocked(prepareRecordingOwnershipPreflight).mockResolvedValue({
		request: "synthetic-signed-challenge",
		expiresAt: Date.now() + 1000,
	});
	vi.mocked(previewRecordingOwnershipTransfer).mockResolvedValue({
		ready: true,
		previewToken: "a".repeat(64),
		objectCount: 1,
	});
	vi.mocked(getRecordingOwnershipTransfer).mockResolvedValue({
		state: "running",
		phase: "copying",
		errorCode: null,
	});
	vi.mocked(startRecordingOwnershipTransfer).mockImplementation(
		async (value) => ({
			operationId: value.requestId,
		}),
	);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => root.render(createElement(RecordingOwnership)));
});

afterEach(async () => {
	await act(async () => root.unmount());
	document.body.replaceChildren();
	delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
	vi.unstubAllGlobals();
});

describe("recording ownership caller", () => {
	it("issues a challenge only on explicit request and downloads it without displaying the token", async () => {
		expect(prepareRecordingOwnershipPreflight).not.toHaveBeenCalled();
		await fill("Recording ID", request.videoId);
		await fill("Destination member ID", request.targetUserId);
		const blob = vi.fn(() => "blob:synthetic");
		Object.defineProperty(URL, "createObjectURL", {
			configurable: true,
			value: blob,
		});
		Object.defineProperty(URL, "revokeObjectURL", {
			configurable: true,
			value: vi.fn(),
		});
		let downloadedName = "";
		const download = vi
			.spyOn(HTMLAnchorElement.prototype, "click")
			.mockImplementation(function (this: HTMLAnchorElement) {
				downloadedName = this.download;
			});
		await click("Download preflight challenge");
		expect(prepareRecordingOwnershipPreflight).toHaveBeenCalledExactlyOnceWith(
			request,
		);
		expect(blob).toHaveBeenCalledOnce();
		expect(download).toHaveBeenCalledOnce();
		expect(downloadedName).toBe("recording-ownership-request.txt");
		expect(container.textContent).not.toContain("synthetic-signed-challenge");
		expect(startRecordingOwnershipTransfer).not.toHaveBeenCalled();
	});

	it("requires a ready preview and confirmation and invalidates them when the destination changes", async () => {
		expect(button("Start or recover transfer").disabled).toBe(true);
		await ready();
		expect(previewRecordingOwnershipTransfer).toHaveBeenCalledExactlyOnceWith({
			...request,
			preflightReceipt: undefined,
		});
		expect(button("Start or recover transfer").disabled).toBe(false);
		await fill("Destination member ID", "test-other");
		expect(button("Start or recover transfer").disabled).toBe(true);
		expect(startRecordingOwnershipTransfer).not.toHaveBeenCalled();
	});

	it("keeps the same request ID and input after an uncertain start response", async () => {
		vi.mocked(startRecordingOwnershipTransfer).mockRejectedValueOnce(
			new Error("Synthetic private detail"),
		);
		await ready();
		await click("Start or recover transfer");
		const original = vi.mocked(startRecordingOwnershipTransfer).mock
			.calls[0]?.[0];
		expect(original?.requestId).toMatch(/^[a-zA-Z0-9_-]{15}$/);
		expect(input("Operation ID").value).toBe(original?.requestId);
		expect(input("Recording ID").closest("fieldset")?.disabled).toBe(true);
		expect(container.textContent).not.toContain("Synthetic private detail");
		await click("Start or recover transfer");
		expect(
			vi.mocked(startRecordingOwnershipTransfer).mock.calls[1]?.[0],
		).toEqual(original);
	});

	it("requires a rollback dry run and supports resuming an existing operation without starting another", async () => {
		await fill("Operation ID", "test-operation");
		await click("Refresh status");
		await click("Retry same operation");
		expect(retryRecordingOwnershipTransfer).toHaveBeenCalledExactlyOnceWith(
			"test-operation",
		);
		expect(button("Confirm cancellation or rollback").disabled).toBe(true);
		vi.mocked(rollbackRecordingOwnershipTransfer).mockResolvedValue({
			phase: "ready",
		});
		await click("Check cancellation or rollback");
		await click("Confirm cancellation or rollback");
		expect(vi.mocked(rollbackRecordingOwnershipTransfer).mock.calls).toEqual([
			[{ operationId: "test-operation", dryRun: true }],
			[{ operationId: "test-operation", dryRun: false }],
		]);
		expect(startRecordingOwnershipTransfer).not.toHaveBeenCalled();
	});

	it("passes a private receipt only to preview and start, and clears it on changed inputs", async () => {
		await fill("Recording ID", request.videoId);
		await fill("Destination member ID", request.targetUserId);
		const file = new File(["synthetic-receipt"], "receipt.txt");
		Object.defineProperty(file, "text", {
			value: async () => "synthetic-receipt",
		});
		const receiptInput = input("Operator receipt (if required)");
		Object.defineProperty(receiptInput, "files", { value: [file] });
		await act(async () =>
			receiptInput.dispatchEvent(new Event("change", { bubbles: true })),
		);
		await click("Check transfer (read only)");
		expect(previewRecordingOwnershipTransfer).toHaveBeenLastCalledWith({
			...request,
			preflightReceipt: "synthetic-receipt",
		});
		expect(container.textContent).not.toContain("synthetic-receipt");
		await fill("Recording ID", "test-other");
		await click("Check transfer (read only)");
		expect(previewRecordingOwnershipTransfer).toHaveBeenLastCalledWith({
			...request,
			videoId: "test-other",
			preflightReceipt: undefined,
		});
	});
});
