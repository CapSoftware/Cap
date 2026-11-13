import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/FontAwesomeIcon", () => ({
	FontAwesomeIcon: () => null,
}));
vi.mock("@/components/Tooltip", () => ({ Tooltip: () => null }));

import { capAnalyticsHref } from "@/app/(org)/dashboard/caps/components/CapCard/CapCardAnalytics";

describe("cap analytics link", () => {
	it("points at the analytics page filtered to the cap", () => {
		const url = new URL(capAnalyticsHref("abc123"), "https://cap.test");

		expect(url.pathname).toBe("/dashboard/analytics");
		expect(url.searchParams.get("capId")).toBe("abc123");
		expect(
			existsSync(
				path.join(__dirname, "../../app/(org)/dashboard/analytics/page.tsx"),
			),
		).toBe(true);
	});
});
