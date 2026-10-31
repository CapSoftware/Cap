// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PasswordGate } from "@/app/s/[videoId]/_components/PasswordGate";

const mocks = vi.hoisted(() => ({
	verifyVideoPassword: vi.fn(),
	refresh: vi.fn(),
}));

vi.mock("@/actions/videos/password", () => ({
	verifyVideoPassword: mocks.verifyVideoPassword,
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ refresh: mocks.refresh }),
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://cap.example" },
}));
vi.mock("@/components/paper-state/doodles", () => ({
	PasswordDoodle: () => null,
}));
vi.mock("@/components/paper-state/PaperState", () => ({
	PaperState: ({ children }: { children: ReactNode }) =>
		createElement("div", null, children),
	paperStateStyles: new Proxy({}, { get: (_, key) => String(key) }),
}));

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	mocks.verifyVideoPassword.mockReset();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	queryClient = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	queryClient.clear();
	vi.unstubAllGlobals();
});

async function submitPassword(password: string) {
	await act(async () => {
		root.render(
			createElement(
				QueryClientProvider,
				{ client: queryClient },
				createElement(PasswordGate, { videoId: "video-1" as never }),
			),
		);
	});
	const input = container.querySelector<HTMLInputElement>(
		"input[type='password']",
	);
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value",
	)?.set;
	if (!input || !setter) throw new Error("Missing password input");
	await act(async () => {
		setter.call(input, password);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await act(async () => {
		container.querySelector("form")?.requestSubmit();
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	return container.querySelector("[role='alert']")?.textContent;
}

describe("PasswordGate errors", () => {
	it("keeps the generic message for a wrong password", async () => {
		mocks.verifyVideoPassword.mockResolvedValue({
			success: false,
			error: "Failed to verify password",
		});

		expect(await submitPassword("nope")).toBe(
			"That password didn't work. Check it and try again.",
		);
	});

	it("tells the viewer to wait when attempts are limited", async () => {
		mocks.verifyVideoPassword.mockResolvedValue({
			success: false,
			error: "Too many attempts. Please try again later.",
		});

		expect(await submitPassword("open")).toBe(
			"Too many attempts. Please try again later.",
		);
		expect(mocks.refresh).not.toHaveBeenCalled();
	});
});
