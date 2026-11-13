import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", () => ({ db: () => ({}) }));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://cap.test" },
	serverEnv: () => ({ WEB_URL: "https://cap.test" }),
}));

import { developerIdFromKey, randomDeveloperId } from "@/lib/developer-ids";
import { transcriptIdForIdempotencyKey } from "@/lib/developer-transcript-store";
import {
	createDeveloperEncodeId,
	createDeveloperPlaybackId,
} from "@/lib/developer-video-plan";
import { developerVideoIdForIdempotencyKey } from "@/lib/developer-video-upload";

const legacyId = (kind: string, appId: string, key: string) =>
	createHash("sha256")
		.update([kind, appId, key].join("\0"), "utf8")
		.digest("base64url")
		.slice(0, 15);

const keys = Array.from({ length: 4_000 }, (_, index) => `key-${index}`);

describe("developer ids", () => {
	it.each([
		["developer-transcript", transcriptIdForIdempotencyKey],
		["developer-video", developerVideoIdForIdempotencyKey],
	] as const)("%s ids never begin with a dash", (kind, idFor) => {
		const dashed = keys.filter((key) =>
			legacyId(kind, "app-1", key).startsWith("-"),
		);
		expect(dashed.length).toBeGreaterThan(10);
		for (const key of keys) {
			const id = idFor("app-1", key);
			expect(id).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_-]{14}$/);
			expect(idFor("app-1", key)).toBe(id);
		}
		for (const key of dashed) {
			expect(idFor("app-1", key)).not.toBe(legacyId(kind, "app-1", key));
		}
	});

	it("keeps the id of every key that never produced a leading dash", () => {
		for (const key of keys) {
			const legacy = legacyId("developer-transcript", "app-1", key);
			if (legacy.startsWith("-")) continue;
			expect(developerIdFromKey("developer-transcript", "app-1", key)).toBe(
				legacy,
			);
		}
	});

	it("draws random ids again until one does not begin with a dash", () => {
		const draws = [
			Buffer.from([0xf8, 0, 0, 0, 0, 0, 0, 0, 0]),
			Buffer.from([0xfb, 0xff, 0, 0, 0, 0, 0, 0, 0]),
			Buffer.from([0x04, 0, 0, 0, 0, 0, 0, 0, 0]),
		];
		expect(draws[0]?.toString("base64url").startsWith("-")).toBe(true);
		expect(draws[1]?.toString("base64url").startsWith("-")).toBe(true);
		let calls = 0;
		const id = randomDeveloperId(9, () => {
			const next = draws[calls];
			calls += 1;
			if (!next) throw new Error("ran out of draws");
			return next;
		});
		expect(calls).toBe(3);
		expect(id).toBe(draws[2]?.toString("base64url"));
	});

	it("never issues a playback or encode id that begins with a dash", () => {
		for (let index = 0; index < 3_000; index += 1) {
			expect(createDeveloperPlaybackId().startsWith("-")).toBe(false);
			expect(createDeveloperEncodeId().startsWith("-")).toBe(false);
		}
	});
});
