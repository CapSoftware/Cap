import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cap/env", () => ({
	buildEnv: {
		NEXT_PUBLIC_WEB_URL: "https://cap.so",
	},
}));

import { getSharePlayerUrl } from "@/lib/share-player-url";

describe("getSharePlayerUrl", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("advertises the dedicated embed player for shared links", () => {
		expect(getSharePlayerUrl("mahyriybqar15xs")).toBe(
			"https://cap.so/embed/mahyriybqar15xs",
		);
	});
});
