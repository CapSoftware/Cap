import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		CAP_CLOUDFRONT_DISTRIBUTION_ID: "EVIRGINIA",
		CAP_TOKYO_CLOUDFRONT_DISTRIBUTION_ID: "ETOKYO",
		CAP_TOKYO_UPLOADS_ENABLED: false,
	}),
}));

import { getVideoCloudFrontDistributionId } from "@/lib/video-cloudfront";

describe("video cache invalidation destination", () => {
	it.each([
		[null, "EVIRGINIA"],
		["cap-tokyo", "ETOKYO"],
		["custom-bucket", undefined],
	])(
		"uses the persisted bucket even with routing disabled: %s",
		(bucket, expected) => {
			expect(getVideoCloudFrontDistributionId(bucket)).toBe(expected);
		},
	);
});
