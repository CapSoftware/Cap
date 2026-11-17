import { describe, expect, it } from "vitest";
import {
	contrastRatio,
	getPlayerBrand,
	MIN_CONTROL_CONTRAST,
	PLAYER_BRAND_INK,
	PLAYER_BRAND_WHITE,
	playerBrandAttributes,
	playerColorFromOrganizationMetadata,
	resolvePlayerBrand,
} from "@/lib/player-brand";

describe("contrastRatio", () => {
	it("matches the WCAG reference values", () => {
		expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
		expect(contrastRatio("#FFFFFF", "#FFFFFF")).toBeCloseTo(1, 5);
		expect(contrastRatio("#767676", "#FFFFFF")).toBeCloseTo(4.54, 2);
	});
});

describe("resolvePlayerBrand", () => {
	it("rejects anything that is not a hex colour", () => {
		for (const value of [null, undefined, "", "blue", "#12", "#GGGGGG", 42]) {
			expect(resolvePlayerBrand(value)).toBeNull();
		}
	});

	it("normalises shorthand and lowercase hex", () => {
		expect(resolvePlayerBrand("#f60")?.color).toBe("#FF6600");
		expect(resolvePlayerBrand("1f6feb")?.color).toBe("#1F6FEB");
	});

	it("picks whichever text colour reads better on the button", () => {
		for (const color of [
			"#1F6FEB",
			"#000000",
			"#FFFFFF",
			"#FFD60A",
			"#7A4DFF",
			"#12A150",
			"#808080",
		]) {
			const brand = resolvePlayerBrand(color);
			if (!brand) throw new Error("expected a brand");
			const chosen = contrastRatio(color, brand.foreground);
			const other = contrastRatio(
				color,
				brand.foreground === PLAYER_BRAND_WHITE
					? PLAYER_BRAND_INK
					: PLAYER_BRAND_WHITE,
			);
			expect(chosen).toBeGreaterThanOrEqual(other);
			expect(chosen).toBeGreaterThanOrEqual(4.5);
		}
		expect(resolvePlayerBrand("#0B1F3A")?.foreground).toBe(PLAYER_BRAND_WHITE);
		expect(resolvePlayerBrand("#FFD60A")?.foreground).toBe(PLAYER_BRAND_INK);
	});

	it("keeps the progress bar white when the colour vanishes on dark video", () => {
		const navy = resolvePlayerBrand("#0B1F3A");
		expect(navy?.accent).toBeNull();
		expect(contrastRatio("#0B1F3A", "#000000")).toBeLessThan(
			MIN_CONTROL_CONTRAST,
		);

		const orange = resolvePlayerBrand("#F26B1D");
		expect(orange?.accent).toBe("#F26B1D");
	});

	it("darkens light-text buttons and lightens dark-text buttons on hover", () => {
		expect(resolvePlayerBrand("#1F6FEB")?.hover).not.toBe("#1F6FEB");
		const blue = resolvePlayerBrand("#1F6FEB");
		const yellow = resolvePlayerBrand("#FFD60A");
		if (!blue || !yellow) throw new Error("expected brands");
		expect(contrastRatio(blue.hover, "#000000")).toBeLessThan(
			contrastRatio(blue.color, "#000000"),
		);
		expect(contrastRatio(yellow.hover, "#000000")).toBeGreaterThan(
			contrastRatio(yellow.color, "#000000"),
		);
	});
});

describe("playerColorFromOrganizationMetadata", () => {
	it("reads only branding.playerColor", () => {
		expect(
			playerColorFromOrganizationMetadata({
				branding: { playerColor: "#12a150" },
			}),
		).toBe("#12A150");
		expect(
			playerColorFromOrganizationMetadata({
				branding: { colors: { primary: "#12A150" } },
			}),
		).toBeNull();
		for (const metadata of [null, undefined, "x", [], { branding: null }]) {
			expect(playerColorFromOrganizationMetadata(metadata)).toBeNull();
		}
		expect(
			playerColorFromOrganizationMetadata({
				branding: { playerColor: "red; background: url(x)" },
			}),
		).toBeNull();
	});
});

describe("getPlayerBrand", () => {
	const metadata = { branding: { playerColor: "#7A4DFF" } };

	it("applies the colour only for Pro owners", () => {
		expect(
			getPlayerBrand({ ownerIsPro: true, organizationMetadata: metadata })
				?.color,
		).toBe("#7A4DFF");
		expect(
			getPlayerBrand({ ownerIsPro: false, organizationMetadata: metadata }),
		).toBeNull();
	});
});

describe("playerBrandAttributes", () => {
	it("renders nothing without a brand", () => {
		expect(playerBrandAttributes(null)).toEqual({});
	});

	it("exposes the colour as CSS variables", () => {
		const attributes = playerBrandAttributes(resolvePlayerBrand("#F26B1D"));
		expect(attributes["data-player-brand"]).toBe("");
		expect(attributes["data-player-brand-accent"]).toBe("");
		expect(attributes.style).toMatchObject({
			"--player-brand": "#F26B1D",
			"--player-brand-foreground": PLAYER_BRAND_INK,
			"--player-brand-accent": "#F26B1D",
		});
		expect(
			(attributes.style as Record<string, string>)["--player-brand-ring"],
		).toMatch(/^\d+(\.\d+)? \d+(\.\d+)?% \d+(\.\d+)?%$/);
	});

	it("leaves the accent off for dark colours", () => {
		const attributes = playerBrandAttributes(resolvePlayerBrand("#0B1F3A"));
		expect(attributes["data-player-brand"]).toBe("");
		expect(attributes["data-player-brand-accent"]).toBeUndefined();
		expect(attributes.style).not.toHaveProperty("--player-brand-accent");
	});
});
