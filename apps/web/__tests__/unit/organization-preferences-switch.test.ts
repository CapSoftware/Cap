// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CapSettingsCard from "@/app/(org)/dashboard/settings/organization/components/CapSettingsCard";

const mocks = vi.hoisted(() => ({
	organizationId: "org-a",
	organizationSettings: {} as Record<string, unknown>,
	updateSettings: vi.fn(),
}));

vi.mock("@/app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => ({
		activeOrganization: { organization: { id: mocks.organizationId } },
		organizationSettings: mocks.organizationSettings,
		user: { isPro: true },
	}),
}));
vi.mock("@/actions/organization/settings", () => ({
	updateOrganizationSettings: mocks.updateSettings,
}));
vi.mock("@uidotdev/usehooks", async () => {
	const { useEffect, useState } = await import("react");
	return {
		useDebounce: <T>(value: T, delay: number) => {
			const [debounced, setDebounced] = useState(value);
			useEffect(() => {
				const timeout = setTimeout(() => setDebounced(value), delay);
				return () => clearTimeout(timeout);
			}, [value, delay]);
			return debounced;
		},
	};
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@cap/ui", () => {
	const container = ({ children }: { children?: ReactNode }) =>
		createElement("div", null, children);
	return {
		Card: container,
		CardDescription: container,
		CardHeader: container,
		CardTitle: container,
		Switch: () => null,
	};
});

let root: Root;
let host: HTMLDivElement;
const render = async () => {
	await act(async () => {
		root.render(createElement(CapSettingsCard));
	});
};
const pickSpeed = async (label: string) => {
	const button = Array.from(host.querySelectorAll("button")).find(
		(element) => element.textContent === label,
	);
	if (!button) throw new Error(`Expected a ${label} speed button`);
	await act(async () => button.click());
};
const waitForDebounce = () =>
	act(async () => {
		await vi.advanceTimersByTimeAsync(1000);
	});

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	mocks.organizationId = "org-a";
	mocks.organizationSettings = {};
	mocks.updateSettings.mockReset().mockResolvedValue({ success: true });
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("organization preferences after switching organizations", () => {
	it("saves an edit to the organization it was made in and never replays it into the next one", async () => {
		await render();
		await pickSpeed("2×");
		await waitForDebounce();

		mocks.organizationId = "org-b";
		mocks.organizationSettings = { disableComments: true };
		await render();
		await waitForDebounce();

		expect(mocks.updateSettings).toHaveBeenCalledTimes(1);
		expect(mocks.updateSettings).toHaveBeenCalledWith(
			expect.objectContaining({ defaultPlaybackSpeed: 2 }),
			"org-a",
		);
	});

	it("saves nothing when the organization changes while an edit waits on the debounce", async () => {
		await render();
		await pickSpeed("2×");
		await act(async () => {
			await vi.advanceTimersByTimeAsync(500);
		});

		mocks.organizationId = "org-b";
		mocks.organizationSettings = { disableComments: true };
		await render();
		await waitForDebounce();
		await waitForDebounce();

		expect(mocks.updateSettings).not.toHaveBeenCalled();
	});
});
