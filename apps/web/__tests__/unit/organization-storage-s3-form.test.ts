// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationStorageSettings } from "@/actions/organization/storage";
import { OrganizationStorageIntegrations } from "@/app/(org)/dashboard/settings/organization/integrations/storage-integrations";

const mocks = vi.hoisted(() => ({
	refresh: vi.fn(),
	testOrganizationS3Config: vi.fn(async () => ({ success: true })),
}));

vi.mock("@/actions/organization/storage", () => ({
	connectOrganizationGoogleDrive: vi.fn(),
	disconnectOrganizationGoogleDrive: vi.fn(),
	getOrganizationGoogleDrivePickerToken: vi.fn(),
	listOrganizationGoogleDriveFolders: vi.fn(),
	removeOrganizationS3Config: vi.fn(),
	saveOrganizationS3Config: vi.fn(),
	setOrganizationGoogleDriveLocation: vi.fn(),
	setOrganizationStorageProvider: vi.fn(),
	testOrganizationS3Config: mocks.testOrganizationS3Config,
}));
vi.mock("@/app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => ({
		user: { isPro: true },
		setUpgradeModalOpen: vi.fn(),
	}),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ refresh: mocks.refresh }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@cap/ui", () => ({
	Button: (props: Record<string, unknown>) =>
		createElement("button", { ...props, type: "button" }),
	Input: (props: Record<string, unknown>) => createElement("input", props),
	Label: (props: Record<string, unknown>) => createElement("label", props),
	Select: () => null,
}));

const settings = (): OrganizationStorageSettings => ({
	organization: { id: "org_1", name: "Org" },
	activeProvider: null,
	googleOAuthClientId: null,
	googlePickerApiKey: null,
	s3: null,
	googleDrive: null,
});

let root: Root;
let container: HTMLDivElement;

const render = (initialSettings: OrganizationStorageSettings) =>
	act(async () => {
		root.render(
			createElement(OrganizationStorageIntegrations, { initialSettings }),
		);
	});

const button = (text: string) =>
	[...container.querySelectorAll("button")].find((element) =>
		element.textContent?.includes(text),
	) as HTMLButtonElement;

const inputs = () => [...container.querySelectorAll("input")];

const type = (input: HTMLInputElement, value: string) => {
	const setValue = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value",
	)?.set;
	setValue?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
};

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	mocks.testOrganizationS3Config.mockClear();
	mocks.refresh.mockReset();
	mocks.refresh.mockImplementation(() => render(settings()));
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

describe("organization S3 storage form", () => {
	it("keeps unsaved values after a successful connection test", async () => {
		await render(settings());
		await act(async () => button("S3-Compatible Storage").click());

		const values = [
			"AKIATEST",
			"secret",
			"https://r2.example.com",
			"my-bucket",
			"auto",
		];
		await act(async () => {
			inputs().forEach((input, index) => {
				type(input, values[index] ?? "");
			});
		});

		await act(async () => button("Test").click());

		expect(mocks.testOrganizationS3Config).toHaveBeenCalledWith(
			expect.objectContaining({
				accessKeyId: "AKIATEST",
				bucketName: "my-bucket",
			}),
		);
		expect(inputs().map((input) => input.value)).toEqual(values);
	});
});
