import { describe, expect, it } from "vitest";
import { canUserDownloadVideo } from "@/lib/video-download-permissions";

describe("canUserDownloadVideo", () => {
	it("grants download access to the video owner", async () => {
		const allowed = await canUserDownloadVideo({
			userId: "user-123" as any,
			ownerId: "user-123" as any,
			videoId: "vid-456" as any,
			orgId: "org-789" as any,
		});

		expect(allowed).toBe(true);
	});
});
