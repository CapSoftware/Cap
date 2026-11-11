import { beforeEach, describe, expect, it, vi } from "vitest";

const redirectMock = vi.fn((url: string) => {
	throw new Error(`REDIRECT:${url}`);
});
const getSelectedInfraAppMock = vi.fn();

vi.mock("next/navigation", () => ({
	redirect: (url: string) => redirectMock(url),
}));

vi.mock("@/app/(infra)/dashboard/infra/infra-data", () => ({
	getSelectedInfraApp: () => getSelectedInfraAppMock(),
}));

import LegacyDevelopersPage from "@/app/(org)/dashboard/developers/[[...path]]/page";

async function redirectFor(
	path: string[] | undefined,
	query: Record<string, string | string[] | undefined> = {},
) {
	try {
		await LegacyDevelopersPage({
			params: Promise.resolve(path ? { path } : {}),
			searchParams: Promise.resolve(query),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.startsWith("REDIRECT:")) return message.slice(9);
		throw error;
	}
	throw new Error("expected a redirect");
}

describe("legacy /dashboard/developers redirects", () => {
	beforeEach(() => {
		redirectMock.mockClear();
		getSelectedInfraAppMock.mockReset();
		getSelectedInfraAppMock.mockResolvedValue({ id: "picked" });
	});

	it("sends the section root and app list to the infra picker", async () => {
		expect(await redirectFor(undefined)).toBe("/dashboard/infra");
		expect(await redirectFor(["apps"])).toBe("/dashboard/infra");
		expect(getSelectedInfraAppMock).not.toHaveBeenCalled();
	});

	it("sends usage and credits to the selected app", async () => {
		expect(await redirectFor(["usage"])).toBe("/dashboard/infra/picked/usage");
		expect(await redirectFor(["credits"], { purchase: "success" })).toBe(
			"/dashboard/infra/picked/billing?purchase=success",
		);
	});

	it("falls back to the picker when the user has no apps", async () => {
		getSelectedInfraAppMock.mockResolvedValue(null);
		expect(await redirectFor(["credits"])).toBe("/dashboard/infra");
	});

	it("maps per-app pages and keeps the query", async () => {
		expect(await redirectFor(["apps", "a1", "api-keys"])).toBe(
			"/dashboard/infra/a1/keys",
		);
		expect(await redirectFor(["apps", "a1", "domains"])).toBe(
			"/dashboard/infra/a1/settings",
		);
		expect(await redirectFor(["apps", "a1", "videos"], { userId: "u 1" })).toBe(
			"/dashboard/infra/a1/videos?userId=u+1",
		);
	});
});
