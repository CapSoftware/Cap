import { resolveEffectiveVideoRules } from "@cap/web-backend";
import { describe, expect, it } from "vitest";

describe("resolveEffectiveVideoRules", () => {
	it("uses space-disabled settings over video and organization settings", () => {
		const rules = resolveEffectiveVideoRules({
			videoSettings: { disableComments: false },
			organizationSettings: { disableComments: false },
			spaces: [
				{
					id: "space-1",
					name: "Design",
					settings: { disableComments: true },
				},
			],
		});

		expect(rules.settings.disableComments).toBe(true);
		expect(rules.inheritedSettings.disableComments).toEqual([
			{ id: "space-1", name: "Design" },
		]);
	});

	it("keeps the inherited setting disabled when multiple spaces conflict", () => {
		const rules = resolveEffectiveVideoRules({
			videoSettings: { disableTranscript: false },
			organizationSettings: { disableTranscript: false },
			spaces: [
				{
					id: "space-1",
					name: "Design",
					settings: { disableTranscript: false },
				},
				{
					id: "space-2",
					name: "Legal",
					settings: { disableTranscript: true },
				},
			],
		});

		expect(rules.settings.disableTranscript).toBe(true);
		expect(rules.inheritedSettings.disableTranscript).toEqual([
			{ id: "space-2", name: "Legal" },
		]);
	});

	it("uses video settings before organization settings when there is no space rule", () => {
		const rules = resolveEffectiveVideoRules({
			videoSettings: { disableCaptions: false },
			organizationSettings: { disableCaptions: true },
			spaces: [],
		});

		expect(rules.settings.disableCaptions).toBe(false);
		expect(rules.inheritedSettings.disableCaptions).toBeUndefined();
	});

	it("uses organization settings when video settings are unset", () => {
		const rules = resolveEffectiveVideoRules({
			videoSettings: {},
			organizationSettings: { disableSummary: true },
			spaces: [],
		});

		expect(rules.settings.disableSummary).toBe(true);
	});

	it("uses video defaultPlaybackSpeed if provided", () => {
		const rules = resolveEffectiveVideoRules({
			videoSettings: { defaultPlaybackSpeed: 1.5 },
			organizationSettings: { defaultPlaybackSpeed: 2 },
			spaces: [],
		});

		expect(rules.settings.defaultPlaybackSpeed).toBe(1.5);
	});

	it("uses organization defaultPlaybackSpeed if video setting is unset", () => {
		const rules = resolveEffectiveVideoRules({
			videoSettings: {},
			organizationSettings: { defaultPlaybackSpeed: 1.25 },
			spaces: [],
		});

		expect(rules.settings.defaultPlaybackSpeed).toBe(1.25);
	});

	it("uses 1 as defaultPlaybackSpeed if unset in both video and organization", () => {
		const rules = resolveEffectiveVideoRules({
			videoSettings: {},
			organizationSettings: {},
			spaces: [],
		});

		expect(rules.settings.defaultPlaybackSpeed).toBe(1);
	});

	it("reports inherited password sources", () => {
		const rules = resolveEffectiveVideoRules({
			videoSettings: {},
			organizationSettings: {},
			spaces: [
				{ id: "space-1", name: "Design", hasPassword: true },
				{ id: "space-2", name: "Marketing", hasPassword: false },
			],
		});

		expect(rules.hasInheritedPassword).toBe(true);
		expect(rules.inheritedPasswordSources).toEqual([
			{ id: "space-1", name: "Design" },
		]);
	});
});
