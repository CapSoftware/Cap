import { describe, expect, it } from "vitest";
import {
	collectPasswordHashes,
	resolveEffectiveVideoRules,
} from "./EffectiveVideoRules.ts";

describe("resolveEffectiveVideoRules", () => {
	it("defaults every viewer setting to enabled when no restrictions exist", () => {
		const rules = resolveEffectiveVideoRules({
			videoSettings: null,
			organizationSettings: null,
			spaces: [],
		});

		expect(rules.settings).toEqual({
			disableSummary: false,
			disableCaptions: false,
			disableChapters: false,
			disableReactions: false,
			disableTranscript: false,
			disableComments: false,
		});
		expect(rules.inheritedSettings).toEqual({});
		expect(rules.hasInheritedPassword).toBe(false);
	});

	it("records every space that forces the same inherited setting", () => {
		const rules = resolveEffectiveVideoRules({
			videoSettings: { disableComments: false },
			organizationSettings: { disableComments: false },
			spaces: [
				{
					id: "space-1",
					name: "Legal",
					settings: { disableComments: true },
				},
				{
					id: "space-2",
					name: "Customer Success",
					settings: { disableComments: true },
				},
			],
		});

		expect(rules.settings.disableComments).toBe(true);
		expect(rules.inheritedSettings.disableComments).toEqual([
			{ id: "space-1", name: "Legal" },
			{ id: "space-2", name: "Customer Success" },
		]);
	});

	it("treats either explicit password metadata or stored password hashes as inherited passwords", () => {
		const rules = resolveEffectiveVideoRules({
			videoSettings: {},
			organizationSettings: {},
			spaces: [
				{ id: "space-1", name: "Recorded Training", hasPassword: true },
				{ id: "space-2", name: "Sales", password: "space-password-hash" },
				{ id: "space-3", name: "Open", hasPassword: false, password: "" },
			],
		});

		expect(rules.hasInheritedPassword).toBe(true);
		expect(rules.inheritedPasswordSources).toEqual([
			{ id: "space-1", name: "Recorded Training" },
			{ id: "space-2", name: "Sales" },
		]);
	});
});

describe("collectPasswordHashes", () => {
	it("preserves the video password first and skips empty inherited passwords", () => {
		expect(
			collectPasswordHashes({
				videoPassword: "video-password-hash",
				spacePasswords: [
					{ password: "space-password-hash" },
					{ password: "" },
					{ password: null },
					{},
				],
			}),
		).toEqual(["video-password-hash", "space-password-hash"]);
	});
});
