// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendDownloadLinkMock = vi.hoisted(() => vi.fn());
const trackEventMock = vi.hoisted(() => vi.fn());
const buildEnvMock = vi.hoisted(() => ({ NEXT_PUBLIC_IS_CAP: "true" }));

vi.mock("@cap/env", () => ({ buildEnv: buildEnvMock }));

vi.mock("@/actions/send-download-link", () => ({
	sendDownloadLink: sendDownloadLinkMock,
}));

vi.mock("@/app/utils/analytics", () => ({
	trackEvent: trackEventMock,
}));

import { PhoneDownload } from "@/components/download/PhoneDownload";

describe("PhoneDownload", () => {
	let root: Root;
	let container: HTMLDivElement;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		vi.clearAllMocks();
		buildEnvMock.NEXT_PUBLIC_IS_CAP = "true";
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	});

	const render = () =>
		act(async () =>
			root.render(createElement(PhoneDownload, { sourcePage: "home_header" })),
		);

	const submit = async (email: string) => {
		const input = container.querySelector("input");
		const form = container.querySelector("form");
		if (!input || !form) throw new Error("email form is missing");
		const setValue = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set;
		await act(async () => {
			setValue?.call(input, email);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			form.dispatchEvent(
				new Event("submit", { bubbles: true, cancelable: true }),
			);
		});
	};

	it("offers the email form and no store link", async () => {
		await render();
		expect(container.querySelector("form")).not.toBeNull();
		expect(container.querySelector("a")).toBeNull();
	});

	it("links to the hosted form where the email cannot be sent", async () => {
		buildEnvMock.NEXT_PUBLIC_IS_CAP = "false";
		await render();
		expect(container.querySelector("form")).toBeNull();
		expect(container.querySelector("a")?.getAttribute("href")).toBe(
			"https://cap.so/download",
		);
		expect(sendDownloadLinkMock).not.toHaveBeenCalled();
	});

	it("confirms where the link was sent", async () => {
		sendDownloadLinkMock.mockResolvedValue({ success: true });
		await render();
		await submit("user@example.com");
		expect(sendDownloadLinkMock).toHaveBeenCalledWith("user@example.com");
		expect(container.querySelector("form")).toBeNull();
		expect(container.querySelector("output")?.textContent).toContain(
			"Sent to user@example.com",
		);
		expect(trackEventMock).toHaveBeenCalledWith("download_link_emailed", {
			source_page: "home_header",
		});
	});

	it("shows the server's reason and keeps the form when sending is refused", async () => {
		sendDownloadLinkMock.mockResolvedValue({
			success: false,
			error: "You've sent too many requests. Please try again later.",
		});
		await render();
		await submit("user@example.com");
		expect(container.querySelector('[role="alert"]')?.textContent).toBe(
			"You've sent too many requests. Please try again later.",
		);
		expect(container.querySelector("form")).not.toBeNull();
		expect(trackEventMock).not.toHaveBeenCalledWith(
			"download_link_emailed",
			expect.anything(),
		);
	});

	it("asks for a retry when the request never reaches the server", async () => {
		sendDownloadLinkMock.mockRejectedValue(new TypeError("Failed to fetch"));
		await render();
		await submit("user@example.com");
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			"try again",
		);
		expect(container.querySelector("form")).not.toBeNull();
		expect(container.querySelector("button")?.disabled).toBe(false);
	});

	it("clears the previous error once a retry succeeds", async () => {
		sendDownloadLinkMock.mockRejectedValueOnce(
			new TypeError("Failed to fetch"),
		);
		sendDownloadLinkMock.mockResolvedValueOnce({ success: true });
		await render();
		await submit("user@example.com");
		expect(container.querySelector('[role="alert"]')).not.toBeNull();
		await submit("user@example.com");
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(container.querySelector("output")).not.toBeNull();
	});
});
