// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ComponentProps, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Settings } from "@/app/(org)/dashboard/settings/account/Settings";

const mocks = vi.hoisted(() => ({
	user: {
		id: "user-1",
		name: "Jane",
		lastName: "Smith",
		email: "jane@example.com",
	},
	persist: vi.fn(),
	refresh: vi.fn(),
	success: vi.fn(),
	error: vi.fn(),
}));
vi.mock("@cap/database", () => ({
	db: () => ({
		update: () => ({
			set: (values: { name?: string; lastName?: string }) => ({
				where: () => mocks.persist(values),
			}),
		}),
	}),
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => mocks.user,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => ({ user: mocks.user, organizationData: [] }),
}));
vi.mock("@/lib/EffectRuntime", () => ({
	useRpcClient: () => ({}),
	useEffectMutation: () => ({ isPending: false }),
}));
vi.mock(
	"@/app/(org)/dashboard/settings/account/components/ProfileImage",
	() => ({
		ProfileImage: () => null,
	}),
);
vi.mock("next/navigation", () => ({
	useRouter: () => ({ refresh: mocks.refresh }),
}));
vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("@/app/utils/analytics", () => ({ resetUser: vi.fn() }));
vi.mock("sonner", () => ({
	toast: { success: mocks.success, error: mocks.error },
}));
vi.mock("@/components/SignedImageUrl", () => ({ SignedImageUrl: () => null }));
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
		Button: ({ children, disabled, onClick, type }: ComponentProps<"button">) =>
			createElement(
				"button",
				{ disabled, onClick, type: type === "submit" ? "submit" : "button" },
				children,
			),
	};
});

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
const editLastName = (value: string) =>
	act(async () => {
		const input = host.querySelector<HTMLInputElement>(
			'input[name="lastName"]',
		);
		if (!input) throw new Error("Expected last name input");
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
const save = () =>
	act(async () => {
		const button = host.querySelector<HTMLButtonElement>(
			'button[type="submit"]',
		);
		if (!button) throw new Error("Expected save button");
		button.click();
	});

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	mocks.user.name = "Jane";
	mocks.user.lastName = "Smith";
	mocks.persist.mockReset().mockImplementation(async (values) => {
		Object.assign(mocks.user, values);
	});
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

describe("account last name updates", () => {
	it.each(["", "   "])(
		"clears the saved last name when the field contains %j",
		async (value) => {
			await render();
			await editLastName(value);
			await save();
			await flush();
			expect(mocks.user.lastName).toBe("");
			expect(mocks.success).toHaveBeenCalledWith("Name updated successfully");
			await act(async () => root.render(null));
			await render();
			expect(
				host.querySelector<HTMLInputElement>('input[name="lastName"]')?.value,
			).toBe("");
			expect(
				host.querySelector<HTMLButtonElement>('button[type="submit"]')
					?.disabled,
			).toBe(true);
		},
	);

	it("trims a replacement last name before saving", async () => {
		await render();
		await editLastName("  Jones  ");
		await save();
		await flush();
		expect(mocks.user.lastName).toBe("Jones");
	});

	it("keeps the saved name and allows retrying when saving fails", async () => {
		mocks.persist.mockRejectedValueOnce(new Error("Database unavailable"));
		await render();
		await editLastName("");
		await save();
		await flush();
		expect(mocks.error).toHaveBeenCalledWith("Failed to update name");
		expect(mocks.success).not.toHaveBeenCalled();
		expect(mocks.user.lastName).toBe("Smith");
		await save();
		await flush();
		expect(mocks.user.lastName).toBe("");
	});
});
