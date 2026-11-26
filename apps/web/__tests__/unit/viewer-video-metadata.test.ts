import { describe, expect, it } from "vitest";
import { withoutCreatorClient } from "@/lib/viewer-video-metadata";

describe("withoutCreatorClient", () => {
	it("drops the desktop client and keeps the other metadata", () => {
		const video = {
			id: "video-1",
			metadata: {
				sourceName: "Display 1",
				desktopClient: { version: "0.6.3", gpui: true },
			},
		};

		expect(withoutCreatorClient(video)).toEqual({
			id: "video-1",
			metadata: { sourceName: "Display 1" },
		});
		expect(video.metadata.desktopClient).toEqual({
			version: "0.6.3",
			gpui: true,
		});
	});

	it("returns videos without a desktop client unchanged", () => {
		const plain = { id: "video-2", metadata: { sourceName: "Window" } };
		const empty = { id: "video-3", metadata: null };

		expect(withoutCreatorClient(plain)).toBe(plain);
		expect(withoutCreatorClient(empty)).toBe(empty);
	});
});
