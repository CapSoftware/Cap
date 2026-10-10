import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		CAP_CLOUDFRONT_DISTRIBUTION_ID: "EVIRGINIA",
		CAP_REGIONAL_UPLOAD_BUCKETS: JSON.stringify({
			"ap-northeast-1": {
				bucket: "cap-test-tokyo",
				bucketUrl: "https://tokyo.cap.test",
				distributionId: "ETOKYO",
			},
			"eu-central-1": {
				bucket: "cap-test-frankfurt",
				bucketUrl: "https://frankfurt.cap.test",
				distributionId: "EFRANKFURT",
			},
		}),
		CAP_REGIONAL_UPLOADS_ENABLED: false,
	}),
}));

import { getVideoCloudFrontDistributionId } from "@/lib/video-cloudfront";

describe("video cache invalidation destination", () => {
	it.each([
		[null, "EVIRGINIA"],
		["cap-tokyo", "ETOKYO"],
		["cap-frankfurt", "EFRANKFURT"],
		["cap-sydney", undefined],
		["custom-bucket", undefined],
	])(
		"uses the persisted bucket even with routing disabled: %s",
		(bucket, expected) => {
			expect(getVideoCloudFrontDistributionId(bucket)).toBe(expected);
		},
	);
});
