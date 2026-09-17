import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ShareNavigation } from "@/app/s/[videoId]/_components/ShareNavigation";

const { currentUser } = vi.hoisted(() => ({ currentUser: vi.fn() }));
vi.mock("@/app/Layout/AuthContext", () => ({ useCurrentUser: currentUser }));

describe("share navigation", () => {
	it("links signed-in viewers directly to their library", () => {
		currentUser.mockReturnValue({ id: "viewer" });
		const markup = renderToStaticMarkup(createElement(ShareNavigation));
		expect(markup).toContain('href="/dashboard/caps"');
		expect(markup).toContain("My Caps");
		expect(markup).not.toContain('target="_blank"');
	});
	it("does not expose account navigation to signed-out viewers", () => {
		currentUser.mockReturnValue(null);
		expect(renderToStaticMarkup(createElement(ShareNavigation))).toBe("");
	});
});
