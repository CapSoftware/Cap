import { describe, expect, it } from "vitest";
import {
	collectPasswordHashes,
	resolveEffectiveVideoRules,
} from "./EffectiveVideoRules";

describe("resolveEffectiveVideoRules", () => {
	it("lets space settings override video and organization defaults", () => {
		const rules = resolveEffectiveVideoRules({
			videoSettings: { disableCaptions: false, disableComments: true },
			organizationSettings: {
				disableCaptions: true,
				disableComments: false,
				disableTranscript: true,
			},
			spaces: [
				{
					id: "space_1",
					name: "Engineering",
					settings: { disableCaptions: true },
				},
			],
		});

		expect(rules.settings).toMatchObject({
			disableCaptions: true,
			disableComments: true,
			disableTranscript: true,
		});
		expect(rules.inheritedSettings.disableCaptions).toEqual([
			{ id: "space_1", name: "Engineering" },
		]);
	});

	it("preserves explicit false video settings over organization true defaults", () => {
		const rules = resolveEffectiveVideoRules({
			videoSettings: { disableSummary: false },
			organizationSettings: { disableSummary: true },
			spaces: [],
		});

		expect(rules.settings.disableSummary).toBe(false);
	});

	it("collects inherited password sources", () => {
		const rules = resolveEffectiveVideoRules({
			spaces: [
				{ id: "space_1", name: "Engineering", hasPassword: true },
				{ id: "space_2", name: "Design", password: "hash" },
				{ id: "space_3", name: "Open" },
			],
		});

		expect(rules.hasInheritedPassword).toBe(true);
		expect(rules.inheritedPasswordSources).toEqual([
			{ id: "space_1", name: "Engineering" },
			{ id: "space_2", name: "Design" },
		]);
	});
});

describe("collectPasswordHashes", () => {
	it("collects video and space password hashes while skipping empty values", () => {
		expect(
			collectPasswordHashes({
				videoPassword: "video_hash",
				spacePasswords: [
					{ password: "space_hash" },
					{ password: null },
					{ password: "" },
					{},
				],
			}),
		).toEqual(["video_hash", "space_hash"]);
	});

	it("handles absent video passwords", () => {
		expect(
			collectPasswordHashes({
				videoPassword: null,
				spacePasswords: [{ password: "space_hash" }],
			}),
		).toEqual(["space_hash"]);
	});
});
