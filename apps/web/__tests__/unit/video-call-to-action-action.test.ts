import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	user: null as { id: string } | null,
	video: null as { ownerId: string } | null,
	updates: [] as unknown[],
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => mocks.user,
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: async () => (mocks.video ? [mocks.video] : []),
			}),
		}),
		update: () => ({
			set: (values: unknown) => ({
				where: async () => {
					mocks.updates.push(values);
				},
			}),
		}),
	}),
}));

import type { Video } from "@cap/web-domain";
import { updateVideoCallToAction } from "@/actions/videos/call-to-action";

const videoId = "video123" as Video.VideoId;

const sqlText = (value: unknown): string => {
	const chunks = (value as { queryChunks?: unknown[] }).queryChunks ?? [];
	return chunks
		.map((chunk) => {
			if (typeof chunk === "string") return chunk;
			if (chunk && typeof chunk === "object" && "value" in chunk) {
				const inner = (chunk as { value: unknown }).value;
				return Array.isArray(inner) ? inner.join("") : String(inner);
			}
			return "?";
		})
		.join("");
};

describe("updateVideoCallToAction", () => {
	beforeEach(() => {
		mocks.user = { id: "owner" };
		mocks.video = { ownerId: "owner" };
		mocks.updates = [];
	});

	it("requires a signed-in user", async () => {
		mocks.user = null;
		await expect(
			updateVideoCallToAction(videoId, { label: "Go", url: "example.com" }),
		).rejects.toThrow("Unauthorized");
		expect(mocks.updates).toHaveLength(0);
	});

	it("only lets the owner change the call to action", async () => {
		mocks.user = { id: "someone-else" };
		await expect(
			updateVideoCallToAction(videoId, { label: "Go", url: "example.com" }),
		).rejects.toThrow("permission");
		expect(mocks.updates).toHaveLength(0);
	});

	it("returns field errors without writing invalid input", async () => {
		const result = await updateVideoCallToAction(videoId, {
			label: "",
			url: "javascript:alert(1)",
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.errors.label).toBeDefined();
		expect(result.errors.url).toBeDefined();
		expect(mocks.updates).toHaveLength(0);
	});

	it("stores the normalized call to action under settings", async () => {
		const result = await updateVideoCallToAction(videoId, {
			label: "Book a call",
			url: "cal.com/demo",
			color: "#12a150",
			showWhilePlaying: false,
		});
		expect(result).toEqual({
			success: true,
			callToAction: {
				label: "Book a call",
				url: "https://cal.com/demo",
				headline: null,
				color: "#12A150",
				showWhilePlaying: false,
			},
		});
		expect(mocks.updates).toHaveLength(1);
		const settings = sqlText(
			(mocks.updates[0] as { settings: unknown }).settings,
		);
		expect(settings).toContain("JSON_SET(");
		expect(settings).toContain("'$.callToAction'");
	});

	it("removes only the call to action key", async () => {
		const result = await updateVideoCallToAction(videoId, null);
		expect(result).toEqual({ success: true, callToAction: null });
		const settings = sqlText(
			(mocks.updates[0] as { settings: unknown }).settings,
		);
		expect(settings).toContain("JSON_REMOVE(");
		expect(settings).toContain("'$.callToAction'");
	});
});
