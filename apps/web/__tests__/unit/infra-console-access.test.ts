import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	user: null as null | { id: string; email: string },
	preview: new Set(["preview@example.com"]),
	requested: null as string | null,
	apps: [] as Record<string, unknown>[],
}));

vi.mock("@cap/database", () => ({
	db: () => {
		const rows = (value: unknown[]) =>
			Object.assign(Promise.resolve(value), {
				groupBy: () => Promise.resolve([]),
				limit: () => Promise.resolve(value),
			});
		const chain = {
			select: () => chain,
			from: () => chain,
			where: () => Object.assign(rows([]), { orderBy: () => rows(mocks.apps) }),
		};
		return chain;
	},
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => mocks.user,
}));
vi.mock("@cap/utils", () => ({ userIsPro: () => false }));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ WEB_URL: "https://web.example" }),
}));
vi.mock("@/lib/infra-access", () => ({
	canUseInfra: (email: string) => mocks.preview.has(email),
}));
vi.mock("@/lib/developer-video-start", () => ({
	redriveDeveloperVideoProcessing: vi.fn(),
}));
vi.mock("next/headers", () => ({
	cookies: async () => ({ get: () => null }),
	headers: async () => ({
		get: (name: string) =>
			name === "x-cap-infra-path" ? mocks.requested : null,
	}),
}));
vi.mock("next/navigation", () => ({
	redirect: (path: string) => {
		throw new Error(`redirect:${path}`);
	},
	notFound: () => {
		throw new Error("not-found");
	},
	usePathname: () => "/dashboard/infra",
	useParams: () => ({ appId: "a 1" }),
}));
vi.mock("next/link", () => ({
	default: ({ href, children }: { href: string; children: ReactNode }) =>
		createElement("a", { href }, children),
}));
vi.mock("next/font/google", () => ({
	Geist: () => ({ variable: "sans" }),
	Geist_Mono: () => ({ variable: "mono" }),
}));
vi.mock("@/app/Layout/AppProviders", () => ({
	AppProviders: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/app/(infra)/dashboard/infra/_components/shell", () => ({
	Brand: () => createElement("span", null, "Cap Infra"),
}));

const data = await import("@/app/(infra)/dashboard/infra/infra-data");
const groupLayout = await import("@/app/(infra)/layout");
const consoleLayout = await import("@/app/(infra)/dashboard/infra/layout");
const consoleNotFound = await import("@/app/(infra)/dashboard/infra/not-found");

const pageNotFound = await import(
	"@/app/(infra)/dashboard/infra/[appId]/not-found"
);
const videoNotFound = await import(
	"@/app/(infra)/dashboard/infra/[appId]/videos/[videoId]/not-found"
);
const unknownPage = await import(
	"@/app/(infra)/dashboard/infra/[appId]/[...missing]/page"
);

const OUTSIDER = { id: "u2", email: "someone@example.com" };
const PREVIEW = { id: "u1", email: "preview@example.com" };

const loginTarget = async (run: () => Promise<unknown>) => {
	const error = await run().then(
		() => null,
		(thrown: Error) => thrown,
	);
	const [, target = ""] = error?.message.match(/^redirect:(.*)$/) ?? [];
	return new URL(target, "https://web.example");
};

beforeEach(() => {
	mocks.user = null;
	mocks.requested = null;
	mocks.apps = [];
});

describe("signing in from a console deep link", () => {
	it.each([
		"/dashboard/infra/a1/billing",
		"/dashboard/infra/a1/videos/v_123",
		"/dashboard/infra/a1/videos?userId=u_42",
	])("comes back to %s", async (path) => {
		mocks.requested = path;
		const url = await loginTarget(() => data.requireInfraApp("a1"));
		expect(url.pathname).toBe("/login");
		expect(url.searchParams.get("next")).toBe(path);
	});

	it("falls back to the app when the address was not forwarded", async () => {
		const url = await loginTarget(() => data.requireInfraApp("a1"));
		expect(url.searchParams.get("next")).toBe("/dashboard/infra/a1");
	});

	it.each([
		"https://evil.example/dashboard/infra/a1",
		"//evil.example/dashboard/infra/a1",
		"/dashboard/caps",
	])("never sends a visitor to %s", async (path) => {
		mocks.requested = path;
		const url = await loginTarget(() => data.requireInfraApp("a1"));
		expect(url.searchParams.get("next")).toBe("/dashboard/infra/a1");
	});
});

describe("an account outside the preview", () => {
	beforeEach(() => {
		mocks.user = OUTSIDER;
	});

	it("is turned away above the console layout", async () => {
		await expect(
			groupLayout.default({ children: createElement("main") }),
		).rejects.toThrow("not-found");
	});

	it("gets no console title", async () => {
		expect(await consoleLayout.generateMetadata()).toEqual({});
		await expect(
			data.infraPageMetadata("Videos")({
				params: Promise.resolve({ appId: "a1" }),
			}),
		).rejects.toThrow("not-found");
	});

	it("gets the plain page even if the console not-found renders", async () => {
		const html = renderToStaticMarkup(await consoleNotFound.default());
		expect(html).toContain("Oops, we couldn&#x27;t find this page");
		expect(html).not.toMatch(/infra|app not found|your apps/i);
	});
});

describe("a preview account on a missing app", () => {
	beforeEach(() => {
		mocks.user = PREVIEW;
	});

	it("passes the group layout", async () => {
		const tree = await groupLayout.default({
			children: createElement("main"),
		});
		expect(isValidElement(tree)).toBe(true);
	});

	it("keeps the console title and drops the section name", async () => {
		expect(await consoleLayout.generateMetadata()).toEqual({
			title: "Cap Infra",
		});
		await expect(
			data.infraPageMetadata("Overview")({
				params: Promise.resolve({ appId: "gone" }),
			}),
		).rejects.toThrow("not-found");
	});

	it("says what is missing and offers the way back", async () => {
		const html = renderToStaticMarkup(await consoleNotFound.default());
		expect(html).toContain("App not found");
		expect(html).toContain("This app does not exist, or it was deleted.");
		expect(html).toContain('href="/dashboard/infra"');
		expect(html).not.toContain("Oops");
	});
});

describe("a signed-out visitor", () => {
	it("is not turned away by the group layout, so the page can send them to sign in", async () => {
		const tree = await groupLayout.default({
			children: createElement("main"),
		});
		expect(isValidElement(tree)).toBe(true);
		expect(
			await data.infraPageMetadata("Videos")({
				params: Promise.resolve({ appId: "a1" }),
			}),
		).toEqual({});
	});
});

describe("a missing page inside an app", () => {
	it("says the video is gone and leads back to the app's videos", () => {
		const html = renderToStaticMarkup(createElement(videoNotFound.default));
		expect(html).toContain("Video not found");
		expect(html).toContain("This video does not exist, or it was deleted.");
		expect(html).toContain('href="/dashboard/infra/a%201/videos"');
	});

	it("answers an unknown address inside the console, not on the site's page", () => {
		expect(() => unknownPage.default()).toThrow("not-found");
		const html = renderToStaticMarkup(createElement(pageNotFound.default));
		expect(html).toContain("Page not found");
		expect(html).toContain('href="/dashboard/infra/a%201/videos"');
	});
});
