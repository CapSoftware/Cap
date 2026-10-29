import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	user: null as {
		id: string;
		stripeSubscriptionStatus?: string | null;
		thirdPartyStripeSubscriptionId?: string | null;
	} | null,
	video: null as { ownerId: string } | null,
	updates: [] as unknown[],
}));

vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: true },
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
import {
	updateDefaultCallToAction,
	updateVideoCallToAction,
} from "@/actions/videos/call-to-action";

const videoId = "video123" as Video.VideoId;

const sqlText = (value: unknown): string => {
	const chunks = (value as { queryChunks?: unknown[] }).queryChunks ?? [];
	return chunks
		.map((chunk): string => {
			if (typeof chunk === "string") return chunk;
			if (chunk && typeof chunk === "object" && "queryChunks" in chunk) {
				return sqlText(chunk);
			}
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
		mocks.user = { id: "owner", stripeSubscriptionStatus: "active" };
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

	it.each([null, "canceled", "unpaid", "incomplete_expired"])(
		"requires an upgrade for an owner with subscription status %s",
		async (stripeSubscriptionStatus) => {
			mocks.user = { id: "owner", stripeSubscriptionStatus };
			for (const input of [{ label: "Go", url: "example.com" }, null]) {
				await expect(updateVideoCallToAction(videoId, input)).resolves.toEqual({
					success: false,
					errors: {},
					upgradeRequired: true,
				});
			}
			expect(mocks.updates).toHaveLength(0);
		},
	);

	it.each([
		{ stripeSubscriptionStatus: "active" },
		{ stripeSubscriptionStatus: "trialing" },
		{ stripeSubscriptionStatus: "past_due" },
		{ thirdPartyStripeSubscriptionId: "sub_example_seat" },
	])("allows an entitled Pro owner: %j", async (entitlement) => {
		mocks.user = { id: "owner", ...entitlement };
		const result = await updateVideoCallToAction(videoId, {
			label: "Go",
			url: "example.com",
		});
		expect(result.success).toBe(true);
		expect(mocks.updates).toHaveLength(1);
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
			source: "video",
		});
		expect(mocks.updates).toHaveLength(1);
		const settings = sqlText(
			(mocks.updates[0] as { settings: unknown }).settings,
		);
		expect(settings).toContain("JSON_SET(");
		expect(settings).toContain("'$.callToAction'");
		expect(settings).toContain('"url":"https://cal.com/demo"');
	});

	it("turns calls to action off for the video so a default can't apply", async () => {
		const result = await updateVideoCallToAction(videoId, null);
		expect(result).toEqual({ success: true, callToAction: null, source: null });
		expect(mocks.updates).toHaveLength(1);
		const settings = sqlText(
			(mocks.updates[0] as { settings: unknown }).settings,
		);
		expect(settings).toContain("'$.callToAction'");
		expect(settings).toContain("CAST('false' AS JSON)");
		expect(settings).not.toContain('"url"');
	});

	it("saves as the owner's default and lets the video follow it", async () => {
		const result = await updateVideoCallToAction(
			videoId,
			{ label: "Book a call", url: "cal.com/demo" },
			{ asDefault: true },
		);
		expect(result).toMatchObject({ success: true, source: "default" });
		expect(mocks.updates).toHaveLength(2);
		const preferences = sqlText(
			(mocks.updates[0] as { preferences: unknown }).preferences,
		);
		expect(preferences).toContain("'$.defaultCallToAction'");
		expect(preferences).toContain('"url":"https://cal.com/demo"');
		const settings = sqlText(
			(mocks.updates[1] as { settings: unknown }).settings,
		);
		expect(settings).toContain("JSON_REMOVE(");
		expect(settings).toContain("'$.callToAction'");
	});
});

describe("updateDefaultCallToAction", () => {
	beforeEach(() => {
		mocks.user = { id: "owner", stripeSubscriptionStatus: "active" };
		mocks.updates = [];
	});

	it("requires a signed-in user", async () => {
		mocks.user = null;
		await expect(updateDefaultCallToAction(null)).rejects.toThrow(
			"Unauthorized",
		);
		expect(mocks.updates).toHaveLength(0);
	});

	it("stores the normalized default in the user's preferences", async () => {
		const result = await updateDefaultCallToAction({
			label: "Try it free",
			url: "cap.so",
		});
		expect(result).toMatchObject({
			success: true,
			callToAction: { label: "Try it free", url: "https://cap.so/" },
		});
		const preferences = sqlText(
			(mocks.updates[0] as { preferences: unknown }).preferences,
		);
		expect(preferences).toContain("JSON_SET(");
		expect(preferences).toContain("'$.defaultCallToAction'");
		// New users' preferences are a JSON null, which COALESCE wouldn't replace.
		expect(preferences).toContain("JSON_TYPE(");
		expect(preferences).not.toContain("COALESCE(");
	});

	it("needs Pro to set a default but not to remove one", async () => {
		mocks.user = { id: "owner", stripeSubscriptionStatus: "canceled" };
		await expect(
			updateDefaultCallToAction({ label: "Go", url: "example.com" }),
		).resolves.toEqual({ success: false, errors: {}, upgradeRequired: true });
		expect(mocks.updates).toHaveLength(0);

		await expect(updateDefaultCallToAction(null)).resolves.toEqual({
			success: true,
			callToAction: null,
		});
		const preferences = sqlText(
			(mocks.updates[0] as { preferences: unknown }).preferences,
		);
		expect(preferences).toContain("JSON_REMOVE(");
		expect(preferences).toContain("'$.defaultCallToAction'");
	});

	it("returns field errors without writing invalid input", async () => {
		const result = await updateDefaultCallToAction({ label: "", url: "" });
		expect(result.success).toBe(false);
		expect(mocks.updates).toHaveLength(0);
	});
});
