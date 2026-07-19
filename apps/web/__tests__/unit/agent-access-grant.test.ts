import { User, Video } from "@cap/web-domain";
import { describe, expect, it, vi } from "vitest";
import { validateAgentAccessGrantPayload } from "@/lib/agent-access-grant";

vi.mock("server-only", () => ({}));

const videoId = Video.VideoId.make("cap_synthetic_grant");
const userId = User.UserId.make("user_synthetic_grant");

describe("agent access grants", () => {
	it("accepts only a live grant bound to the same user and Cap", () => {
		const value = {
			videoId,
			userId,
			passwordHash: "h".repeat(64),
			expiresAt: "2026-07-18T18:30:00.000Z",
		};
		expect(
			validateAgentAccessGrantPayload(
				value,
				videoId,
				userId,
				Date.parse("2026-07-18T18:20:00.000Z"),
			),
		).toMatchObject({ passwordHash: "h".repeat(64) });
		expect(
			validateAgentAccessGrantPayload(
				value,
				videoId,
				User.UserId.make("different_user"),
				Date.parse("2026-07-18T18:20:00.000Z"),
			),
		).toBeNull();
		expect(
			validateAgentAccessGrantPayload(
				value,
				videoId,
				userId,
				Date.parse("2026-07-18T18:31:00.000Z"),
			),
		).toBeNull();
	});

	it("rejects malformed payloads without exposing their contents", () => {
		expect(
			validateAgentAccessGrantPayload(
				{ videoId, userId, passwordHash: "short", expiresAt: "invalid" },
				videoId,
				userId,
			),
		).toBeNull();
	});
});
