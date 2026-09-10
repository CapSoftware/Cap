import Cookies from "js-cookie";
import { JSDOM } from "jsdom";
import {
	act,
	type ComponentProps,
	createElement,
	Fragment,
	useLayoutEffect,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardContexts } from "@/app/(org)/dashboard/Contexts";
import { ShareTheme } from "@/app/s/ShareTheme";

vi.mock("@cap/env", () => ({ buildEnv: { NEXT_PUBLIC_IS_CAP: false } }));
vi.mock("next/navigation", () => ({
	usePathname: () => window.location.pathname,
	redirect: vi.fn(),
}));
vi.mock("@/app/Layout/AuthContext", () => ({
	useCurrentUser: () => ({ id: "test-viewer" }),
}));
vi.mock(
	"@/app/(org)/dashboard/settings/organization/components/InviteDialog",
	() => ({ InviteDialog: () => null }),
);
vi.mock("@/components/UpgradeModal", () => ({ UpgradeModal: () => null }));

let dom: JSDOM;
let root: Root;
let systemDark: boolean;
let mediaChanges: EventTarget;
const beforePaint: string[] = [];
const dashboardProps = {
	children: null,
	organizationData: null,
	activeOrganization: null,
	spacesData: null,
	userCapsCount: 0,
	organizationSettings: null,
	userPreferences: null,
	anyNewNotifications: false,
	initialTheme: "light",
	initialSidebarCollapsed: false,
	referClicked: false,
	shareableLinkUsage: null,
} satisfies ComponentProps<typeof DashboardContexts>;

function PaintProbe() {
	useLayoutEffect(() => {
		beforePaint.push(document.body.className);
	});
	return null;
}

async function navigate(route: "dashboard" | "share" | "marketing") {
	window.history.replaceState(
		null,
		"",
		route === "share" ? "/s/test-video" : `/${route}`,
	);
	const page =
		route === "dashboard"
			? createElement(DashboardContexts, dashboardProps)
			: route === "share"
				? createElement(ShareTheme)
				: null;
	await act(async () => {
		root.render(createElement(Fragment, null, page, createElement(PaintProbe)));
	});
}

beforeEach(() => {
	dom = new JSDOM(
		"<!doctype html><body class='light'><div id='root'></div></body>",
		{ url: "http://localhost" },
	);
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.window.document);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	systemDark = false;
	mediaChanges = new EventTarget();
	dom.window.matchMedia = vi.fn(() => ({
		get matches() {
			return systemDark;
		},
		media: "(prefers-color-scheme: dark)",
		onchange: null,
		addListener: vi.fn(),
		removeListener: vi.fn(),
		addEventListener: mediaChanges.addEventListener.bind(mediaChanges),
		removeEventListener: mediaChanges.removeEventListener.bind(mediaChanges),
		dispatchEvent: mediaChanges.dispatchEvent.bind(mediaChanges),
	}));
	root = createRoot(document.getElementById("root") as HTMLElement);
	beforePaint.length = 0;
});

afterEach(async () => {
	await act(async () => root.unmount());
	dom.window.close();
	vi.unstubAllGlobals();
});

describe("theme at the navigation paint boundary", () => {
	it("keeps saved dark mode before paint in both navigation directions", async () => {
		Cookies.set("theme", "dark");
		await navigate("dashboard");
		await navigate("share");
		await navigate("dashboard");
		expect(beforePaint).toEqual(["dark", "dark", "dark"]);
		expect(document.body.className).toBe("dark");
	});

	it("honors saved light mode even when the system is dark", async () => {
		Cookies.set("theme", "light");
		systemDark = true;
		await navigate("dashboard");
		await navigate("share");
		await navigate("dashboard");
		expect(beforePaint).toEqual(["light", "light", "light"]);
	});

	it("uses system dark on share pages and restores the dashboard default", async () => {
		systemDark = true;
		await navigate("dashboard");
		await navigate("share");
		await navigate("dashboard");
		expect(beforePaint).toEqual(["light", "dark", "light"]);
	});

	it("removes share listeners and dark mode when leaving for marketing", async () => {
		systemDark = true;
		await navigate("share");
		await navigate("marketing");
		mediaChanges.dispatchEvent(new Event("change"));
		window.dispatchEvent(new dom.window.Event("focus"));
		expect(beforePaint).toEqual(["dark", "light"]);
		expect(document.body.className).toBe("light");
	});
});
