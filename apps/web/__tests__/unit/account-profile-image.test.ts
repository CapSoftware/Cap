// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Effect } from "effect";
import { act, type ComponentProps, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Settings } from "@/app/(org)/dashboard/settings/account/Settings";

const mocks = vi.hoisted(() => ({
	imageUrl: "https://example.com/original.png" as string | null,
	updateUser: vi.fn(),
	refresh: vi.fn(),
	success: vi.fn(),
	error: vi.fn(),
	createObjectURL: vi.fn(),
	revokeObjectURL: vi.fn(),
}));
vi.mock("@/app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => ({
		user: {
			id: "user-1",
			name: "Jane",
			lastName: "Smith",
			email: "jane@example.com",
			defaultOrgId: "org-1",
			imageUrl: mocks.imageUrl,
		},
		organizationData: [],
	}),
}));
vi.mock("@/lib/EffectRuntime", async () => {
	const { Layer, ManagedRuntime } = await import("effect");
	const { makeUseEffectMutation } = await import("@/lib/effect-react-query");
	const { afterAll } = await import("vitest");
	const runtime = ManagedRuntime.make(Layer.empty);
	afterAll(() => runtime.dispose());
	return {
		useRpcClient: () => ({ UserUpdate: mocks.updateUser }),
		useEffectMutation: makeUseEffectMutation(() => runtime),
	};
});
vi.mock("@/app/(org)/dashboard/settings/account/server", () => ({
	patchAccountSettings: vi.fn(),
	signOutAllDevices: vi.fn(),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ refresh: mocks.refresh }),
}));
vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("@/app/utils/analytics", () => ({ resetUser: vi.fn() }));
vi.mock("sonner", () => ({
	toast: { success: mocks.success, error: mocks.error },
}));
vi.mock("@cap/ui", () => {
	const container = ({ children }: { children?: ReactNode }) =>
		createElement("div", null, children);
	return {
		Card: container,
		CardDescription: container,
		CardTitle: container,
		Dialog: () => null,
		DialogContent: container,
		DialogFooter: container,
		DialogHeader: container,
		DialogTitle: container,
		Select: () => null,
		Input: (props: ComponentProps<"input">) => createElement("input", props),
		Button: ({
			children,
			disabled,
			onClick,
			type = "button",
		}: ComponentProps<"button">) =>
			createElement(
				"button",
				{ disabled, onClick, type: type === "submit" ? "submit" : "button" },
				children,
			),
	};
});
vi.mock("@/components/SignedImageUrl", () => ({
	SignedImageUrl: ({ image }: { image: string }) =>
		createElement("span", { "data-image": image }),
}));
vi.mock("@/components/Tooltip", () => ({
	Tooltip: ({ content, children }: { content: string; children?: ReactNode }) =>
		createElement("span", { title: content }, children),
}));
vi.mock("@fortawesome/react-fontawesome", () => ({
	FontAwesomeIcon: () => null,
}));

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
const render = () =>
	act(async () => {
		root.render(
			createElement(
				QueryClientProvider,
				{ client: queryClient },
				createElement(Settings),
			),
		);
	});
const flush = () =>
	act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
const preview = () =>
	host.querySelector("[data-image]")?.getAttribute("data-image");
const fileInput = () => {
	const input = host.querySelector<HTMLInputElement>('input[type="file"]');
	if (!input) throw new Error("Expected profile image input");
	return input;
};
const upload = () =>
	act(async () => {
		const file = new File(["image"], "avatar.png", { type: "image/png" });
		Object.defineProperty(file, "arrayBuffer", {
			value: async () => new ArrayBuffer(5),
		});
		Object.defineProperty(fileInput(), "files", {
			configurable: true,
			value: [file],
		});
		Object.defineProperty(fileInput(), "value", {
			configurable: true,
			writable: true,
			value: "C:\\fakepath\\avatar.png",
		});
		fileInput().dispatchEvent(new Event("change", { bubbles: true }));
	});

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	mocks.imageUrl = "https://example.com/original.png";
	mocks.updateUser.mockReset().mockReturnValue(Effect.void);
	mocks.createObjectURL.mockReturnValue("blob:profile-preview");
	vi.stubGlobal(
		"URL",
		class extends URL {
			static createObjectURL = mocks.createObjectURL;
			static revokeObjectURL = mocks.revokeObjectURL;
		},
	);
	vi.spyOn(console, "error").mockImplementation(() => {});
	queryClient = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	queryClient.clear();
	host.remove();
	vi.unstubAllGlobals();
});

describe("account profile image failures", () => {
	it.each(["https://example.com/original.png", null])(
		"restores the saved image %s after an upload fails and allows retrying the same file",
		async (savedImage) => {
			mocks.imageUrl = savedImage;
			const pending = Promise.withResolvers<void>();
			mocks.updateUser.mockReturnValueOnce(
				Effect.tryPromise(() => pending.promise),
			);
			await render();
			await upload();
			expect(preview()).toBe("blob:profile-preview");
			expect(fileInput().disabled).toBe(true);
			await act(async () => pending.reject(new Error("Upload failed")));
			await flush();
			expect(mocks.error).toHaveBeenCalled();
			expect(mocks.success).not.toHaveBeenCalled();
			expect(preview()).toBe(savedImage ?? undefined);
			expect(mocks.revokeObjectURL).toHaveBeenCalledWith(
				"blob:profile-preview",
			);
			expect(fileInput().value).toBe("");
			await upload();
			await flush();
			expect(mocks.updateUser).toHaveBeenCalledTimes(2);
		},
	);
	it("restores the image after removal fails", async () => {
		mocks.updateUser.mockReturnValueOnce(
			Effect.fail(new Error("Delete failed")),
		);
		await render();
		const remove = host.querySelector<HTMLButtonElement>(
			'[title="Remove image"] button',
		);
		if (!remove) throw new Error("Expected remove image button");
		await act(async () => remove.click());
		await flush();
		expect(mocks.error).toHaveBeenCalled();
		expect(preview()).toBe(mocks.imageUrl);
	});
	it("keeps a successful upload preview until the refreshed image arrives", async () => {
		await render();
		await upload();
		await flush();
		expect(mocks.success).toHaveBeenCalled();
		expect(preview()).toBe("blob:profile-preview");
		mocks.imageUrl = "https://example.com/new.png";
		await render();
		expect(preview()).toBe(mocks.imageUrl);
		expect(mocks.revokeObjectURL).toHaveBeenCalledWith("blob:profile-preview");
	});
	it("releases an upload preview when leaving settings", async () => {
		await render();
		await upload();
		await flush();
		await act(async () => root.render(null));
		expect(mocks.revokeObjectURL).toHaveBeenCalledWith("blob:profile-preview");
	});
});
