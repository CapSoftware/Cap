import { describe, expect, it } from "vitest";
import {
	CORNER_CARD_MIN_WIDTH,
	callToActionDestinationLabel,
	DEFAULT_CTA_COLOR,
	normalizeCallToActionUrl,
	normalizeHexColor,
	parseShareCallToAction,
	parseWorkspaceCallToAction,
	readableTextColor,
	resolveShareCallToAction,
	type ShareCallToAction,
	shouldShowCornerCard,
	toStoredCallToAction,
	validateCallToAction,
	withoutWorkspaceCallToAction,
} from "@/lib/share-call-to-action";

describe("normalizeCallToActionUrl", () => {
	it("adds https to bare domains", () => {
		expect(normalizeCallToActionUrl("cal.com/demo")).toBe(
			"https://cal.com/demo",
		);
		expect(normalizeCallToActionUrl("  example.com  ")).toBe(
			"https://example.com/",
		);
	});

	it("treats a bare host with a port as a web link", () => {
		expect(normalizeCallToActionUrl("cap.so:8080/demo")).toBe(
			"https://cap.so:8080/demo",
		);
	});

	it("keeps explicit http and https links", () => {
		expect(normalizeCallToActionUrl("http://example.com/a?b=1#c")).toBe(
			"http://example.com/a?b=1#c",
		);
		expect(normalizeCallToActionUrl("https://example.com/demo")).toBe(
			"https://example.com/demo",
		);
	});

	it("accepts mailto links with a real address", () => {
		expect(normalizeCallToActionUrl("mailto:hello@example.com")).toBe(
			"mailto:hello@example.com",
		);
		expect(normalizeCallToActionUrl("mailto:nobody")).toBeNull();
		expect(normalizeCallToActionUrl("mailto:hello%ZZ@example.com")).toBeNull();
	});

	it("rejects script and data schemes", () => {
		expect(normalizeCallToActionUrl("javascript:alert(1)")).toBeNull();
		expect(normalizeCallToActionUrl("JavaScript:alert(1)")).toBeNull();
		expect(
			normalizeCallToActionUrl("data:text/html,<script>1</script>"),
		).toBeNull();
		expect(normalizeCallToActionUrl("vbscript:msgbox")).toBeNull();
		expect(normalizeCallToActionUrl("file:///etc/passwd")).toBeNull();
	});

	it("rejects hosts without a dot, whitespace and embedded credentials", () => {
		expect(normalizeCallToActionUrl("book")).toBeNull();
		expect(normalizeCallToActionUrl("https://localhost:3000")).toBeNull();
		expect(normalizeCallToActionUrl("example .com")).toBeNull();
		expect(normalizeCallToActionUrl("https://user:pw@example.com")).toBeNull();
		expect(normalizeCallToActionUrl("")).toBeNull();
	});

	it("rejects links over the length limit", () => {
		expect(
			normalizeCallToActionUrl(`https://example.com/${"a".repeat(2100)}`),
		).toBeNull();
	});
});

describe("normalizeHexColor", () => {
	it("normalizes short and long hex values", () => {
		expect(normalizeHexColor("#abc")).toBe("#AABBCC");
		expect(normalizeHexColor("12a150")).toBe("#12A150");
		expect(normalizeHexColor(" #7a4dff ")).toBe("#7A4DFF");
	});

	it("rejects anything that is not a hex color", () => {
		expect(normalizeHexColor("red")).toBeNull();
		expect(normalizeHexColor("#12345")).toBeNull();
		expect(normalizeHexColor("url(evil)")).toBeNull();
		expect(normalizeHexColor(42)).toBeNull();
	});
});

describe("validateCallToAction", () => {
	it("returns a normalized call to action", () => {
		expect(
			validateCallToAction({
				label: "  Book   a call ",
				url: "cal.com/demo",
				headline: "  Want a walkthrough? ",
				color: "#12a150",
				showWhilePlaying: false,
			}),
		).toEqual({
			ok: true,
			value: {
				label: "Book a call",
				url: "https://cal.com/demo",
				headline: "Want a walkthrough?",
				color: "#12A150",
				showWhilePlaying: false,
			},
		});
	});

	it("defaults the optional fields", () => {
		const result = validateCallToAction({
			label: "Try it",
			url: "example.com",
		});
		expect(result).toEqual({
			ok: true,
			value: {
				label: "Try it",
				url: "https://example.com/",
				headline: null,
				color: DEFAULT_CTA_COLOR,
				showWhilePlaying: true,
			},
		});
	});

	it("reports every invalid field", () => {
		const result = validateCallToAction({
			label: " ",
			url: "javascript:alert(1)",
			headline: "x".repeat(81),
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(Object.keys(result.errors).sort()).toEqual([
			"headline",
			"label",
			"url",
		]);
	});

	it("rejects labels over the limit and missing links", () => {
		const result = validateCallToAction({ label: "x".repeat(41), url: "" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.label).toBeDefined();
		expect(result.errors.url).toBeDefined();
	});
});

describe("parseShareCallToAction", () => {
	it("reads a stored call to action from video settings", () => {
		expect(
			parseShareCallToAction({
				disableComments: true,
				callToAction: {
					label: "Book a call",
					url: "https://cal.com/demo",
					color: "#2F6BFF",
					showWhilePlaying: true,
				},
			}),
		).toEqual({
			label: "Book a call",
			url: "https://cal.com/demo",
			headline: null,
			color: "#2F6BFF",
			showWhilePlaying: true,
		});
	});

	it("ignores missing, malformed and unsafe stored values", () => {
		expect(parseShareCallToAction(null)).toBeNull();
		expect(parseShareCallToAction({})).toBeNull();
		expect(parseShareCallToAction({ callToAction: "Book" })).toBeNull();
		expect(
			parseShareCallToAction({ callToAction: { label: "Go", url: 5 } }),
		).toBeNull();
		expect(
			parseShareCallToAction({
				callToAction: { label: "Go", url: "javascript:alert(1)" },
			}),
		).toBeNull();
	});

	it("round-trips through the stored shape", () => {
		const result = validateCallToAction({
			label: "Reply to me",
			url: "mailto:hello@example.com",
			headline: "Questions?",
			color: "#E5337A",
			showWhilePlaying: false,
		});
		if (!result.ok) throw new Error("expected valid input");
		expect(
			parseShareCallToAction({
				callToAction: toStoredCallToAction(result.value),
			}),
		).toEqual(result.value);
	});

	it("omits an empty headline from the stored shape", () => {
		const stored = toStoredCallToAction({
			label: "Go",
			url: "https://example.com/",
			headline: null,
			color: DEFAULT_CTA_COLOR,
			showWhilePlaying: true,
		});
		expect(stored).not.toHaveProperty("headline");
	});
});

describe("readableTextColor", () => {
	it("picks white on dark colors and ink on light colors", () => {
		expect(readableTextColor("#2F6BFF")).toBe("#FFFFFF");
		expect(readableTextColor("#111113")).toBe("#FFFFFF");
		expect(readableTextColor("#FFE14D")).toBe("#111113");
		expect(readableTextColor("#FFFFFF")).toBe("#111113");
	});
});

describe("callToActionDestinationLabel", () => {
	it("shows the host or email address", () => {
		expect(callToActionDestinationLabel("https://www.cal.com/demo")).toBe(
			"cal.com",
		);
		expect(callToActionDestinationLabel("mailto:hello@example.com")).toBe(
			"hello@example.com",
		);
	});
});

describe("shouldShowCornerCard", () => {
	const cta: ShareCallToAction = {
		label: "Book a call",
		url: "https://cal.com/demo",
		headline: null,
		color: DEFAULT_CTA_COLOR,
		showWhilePlaying: true,
	};
	const visible = {
		cta,
		width: 960,
		height: 540,
		dismissed: false,
		pastIntro: true,
		ended: false,
	};

	it("shows on a large player once playback is underway", () => {
		expect(shouldShowCornerCard(visible)).toBe(true);
	});

	it("stays hidden on small players", () => {
		expect(
			shouldShowCornerCard({
				...visible,
				width: CORNER_CARD_MIN_WIDTH - 1,
			}),
		).toBe(false);
		expect(shouldShowCornerCard({ ...visible, width: 390, height: 219 })).toBe(
			false,
		);
		expect(shouldShowCornerCard({ ...visible, height: 200 })).toBe(false);
	});

	it("stays hidden before the intro, after dismissal and at the end", () => {
		expect(shouldShowCornerCard({ ...visible, pastIntro: false })).toBe(false);
		expect(shouldShowCornerCard({ ...visible, dismissed: true })).toBe(false);
		expect(shouldShowCornerCard({ ...visible, ended: true })).toBe(false);
	});

	it("respects the owner turning the corner card off", () => {
		expect(
			shouldShowCornerCard({
				...visible,
				cta: { ...cta, showWhilePlaying: false },
			}),
		).toBe(false);
	});
});

describe("workspace call to action", () => {
	const stored = {
		label: "Talk to sales",
		url: "https://example.com/sales",
		color: "#12a150",
		enabledAt: "2026-10-01T12:00:00.000Z",
	};
	const organizationSettings = (extra: Record<string, unknown> = {}) => ({
		defaultCallToAction: { ...stored, ...extra },
	});

	it("parses a stored default and normalizes it like a video's", () => {
		expect(parseWorkspaceCallToAction(organizationSettings())).toEqual({
			callToAction: {
				label: "Talk to sales",
				url: "https://example.com/sales",
				headline: null,
				color: "#12A150",
				showWhilePlaying: true,
			},
			enabledAt: stored.enabledAt,
			includeExisting: false,
		});
	});

	it.each([
		null,
		{},
		{ defaultCallToAction: null },
		{ defaultCallToAction: { ...stored, url: "javascript:alert(1)" } },
		{ defaultCallToAction: { ...stored, enabledAt: undefined } },
		{ defaultCallToAction: { ...stored, enabledAt: "not a date" } },
	])("ignores a missing or unusable default: %j", (settings) => {
		expect(parseWorkspaceCallToAction(settings)).toBeNull();
	});

	const resolve = (
		videoSettings: unknown,
		videoCreatedAt: Date | string | null,
		extra: Record<string, unknown> = {},
	) =>
		resolveShareCallToAction({
			videoSettings,
			organizationSettings: organizationSettings(extra),
			videoCreatedAt,
		});

	it("applies to videos made at or after the moment it was set", () => {
		expect(resolve({}, new Date(stored.enabledAt))).toMatchObject({
			callToAction: { label: "Talk to sales" },
			source: "workspace",
		});
		expect(resolve(null, "2026-11-01T00:00:00.000Z").source).toBe("workspace");
	});

	it("leaves older videos alone unless it covers existing videos", () => {
		expect(resolve({}, "2026-10-01T11:59:59.000Z")).toEqual({
			callToAction: null,
			source: null,
			workspaceCallToAction: null,
		});
		expect(resolve({}, null).callToAction).toBeNull();
		expect(
			resolve({}, "2020-01-01T00:00:00.000Z", { includeExisting: true }).source,
		).toBe("workspace");
	});

	it("lets a video's own call to action win", () => {
		const result = resolve(
			{ callToAction: { label: "Mine", url: "https://example.com/" } },
			"2026-11-01T00:00:00.000Z",
		);
		expect(result.source).toBe("video");
		expect(result.callToAction?.label).toBe("Mine");
		expect(result.workspaceCallToAction?.label).toBe("Talk to sales");
	});

	it("respects a video that turned it off", () => {
		expect(
			resolve({ callToAction: false }, "2026-11-01T00:00:00.000Z"),
		).toMatchObject({ callToAction: null, source: "off" });
	});

	it("falls back to the default when a video's own call to action is broken", () => {
		expect(
			resolve(
				{ callToAction: { label: "Bad", url: "javascript:alert(1)" } },
				"2026-11-01T00:00:00.000Z",
			).source,
		).toBe("workspace");
	});

	it("keeps today's behaviour when there is no default", () => {
		expect(
			resolveShareCallToAction({
				videoSettings: {
					callToAction: { label: "Mine", url: "https://example.com/" },
				},
				organizationSettings: { disableComments: true },
				videoCreatedAt: new Date(),
			}),
		).toMatchObject({ source: "video", workspaceCallToAction: null });
		expect(
			resolveShareCallToAction({
				videoSettings: { callToAction: false },
				organizationSettings: null,
				videoCreatedAt: new Date(),
			}).callToAction,
		).toBeNull();
	});

	it("strips the default from settings sent to viewers", () => {
		const settings = { disableComments: true, ...organizationSettings() };
		expect(withoutWorkspaceCallToAction(settings)).toEqual({
			disableComments: true,
		});
		expect(settings.defaultCallToAction).toBeDefined();
		const plain = { disableComments: true };
		expect(withoutWorkspaceCallToAction(plain)).toBe(plain);
		expect(withoutWorkspaceCallToAction(null)).toBeNull();
	});
});
