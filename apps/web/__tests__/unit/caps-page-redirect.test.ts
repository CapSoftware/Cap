import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	redirect: vi.fn((url: string) => {
		throw new Error(`redirect:${url}`);
	}),
	view: vi.fn(async (_props: unknown) => null),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/app/(org)/dashboard/caps/caps-page-data", () => ({
	CapsPageView: mocks.view,
}));

const { default: CapsPage } = await import("@/app/(org)/dashboard/caps/page");

const open = (searchParams: Record<string, string | string[]>) =>
	CapsPage({
		params: Promise.resolve({}),
		searchParams: Promise.resolve(searchParams),
	} as never);

beforeEach(() => {
	mocks.redirect.mockClear();
	mocks.view.mockClear();
});

describe("My Caps page links", () => {
	it.each([
		[{ page: "3" }, 3],
		[{ page: "1" }, 1],
		[{ page: ["2", "9"] }, 2],
		[{ page: "not-a-page" }, 1],
		[{ page: "-4" }, 1],
	])(
		"sends the old list link %j to that page of Videos",
		async (params, page) => {
			await expect(open(params)).rejects.toThrow(
				`redirect:/dashboard/caps/videos?page=${page}`,
			);
			expect(mocks.view).not.toHaveBeenCalled();
		},
	);

	it("shows the overview when no page is asked for", async () => {
		await open({ upgrade: "true" });

		expect(mocks.redirect).not.toHaveBeenCalled();
		expect(mocks.view).toHaveBeenCalledWith({
			searchParams: { upgrade: "true" },
			view: "library",
		});
	});
});
