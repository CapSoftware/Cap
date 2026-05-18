import { describe, expect, it } from "vitest";
import {
	collectPasswordHashes,
	resolveEffectiveVideoRules,
} from "./EffectiveVideoRules";

describe("resolveEffectiveVideoRules", () => {
	it("lets space settings override video and organization defaults", () => {
		const rules = resolveEffectiveVideoRules({
			videoSettings: {
				disableCaptions: false,
				disableComments: true,
			},
			organizationSettings: {
				disableCaptions: true,
				disableTranscript: true,
			},
			spaces: [
				{
					id: "space-1",
					name: "Engineering",
					settings: {
						disableCaptions: true,
						disableSummary: true,
					},
				},
			],
		});

		expect(rules.settings).toMatchObject({
			disableCaptions: true,
			disableComments: true,
			disableSummary: true,
			disableTranscript: true,
		});
		expect(rules.inheritedSettings.disableCaptions).toEqual([
			{ id: "space-1", name: "Engineering" },
		]);
		expect(rules.inheritedSettings.disableSummary).toEqual([
			{ id: "space-1", name: "Engineering" },
		]);
	});

	it("collects inherited password sources from flags and hashes", () => {
		const rules = resolveEffectiveVideoRules({
			spaces: [
				{ id: "space-1", name: "Flagged", hasPassword: true },
				{ id: "space-2", name: "Has hash", password: "hash-2" },
				{ id: "space-3", name: "Open" },
			],
		});

		expect(rules.hasInheritedPassword).toBe(true);
		expect(rules.inheritedPasswordSources).toEqual([
			{ id: "space-1", name: "Flagged" },
			{ id: "space-2", name: "Has hash" },
		]);
	});
});

describe("collectPasswordHashes", () => {
	it("keeps the video password first and removes empty space passwords", () => {
		expect(
			collectPasswordHashes({
				videoPassword: "video-hash",
				spacePasswords: [
					{ password: "space-hash" },
					{ password: "" },
					{ password: null },
					{},
				],
			}),
		).toEqual(["video-hash", "space-hash"]);
	});
});
