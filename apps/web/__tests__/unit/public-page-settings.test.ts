import { PublicCollection } from "@cap/web-domain";
import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";

const decode = Schema.decodeUnknownEither(
	PublicCollection.PublicPageSettingsUpdate,
);

describe("PublicPageSettingsUpdate", () => {
	it("accepts a valid partial patch", () => {
		const result = decode({ title: "Launch videos", gridColumns: 3 });
		expect(Either.isRight(result)).toBe(true);
	});

	it("strips logoUrl — only the upload action may write it", () => {
		const result = decode({
			logoUrl: "organizations/other-org/logo.svg",
			title: "t",
		});
		expect(Either.isRight(result)).toBe(true);
		if (Either.isRight(result)) {
			expect("logoUrl" in result.right).toBe(false);
		}
	});

	it("rejects oversized text fields", () => {
		const over = (length: number) => "x".repeat(length + 1);
		expect(
			Either.isLeft(
				decode({
					title: over(PublicCollection.PUBLIC_PAGE_TITLE_MAX_LENGTH),
				}),
			),
		).toBe(true);
		expect(
			Either.isLeft(
				decode({
					subtitle: over(PublicCollection.PUBLIC_PAGE_SUBTITLE_MAX_LENGTH),
				}),
			),
		).toBe(true);
		expect(
			Either.isLeft(
				decode({
					ctaLabel: over(PublicCollection.PUBLIC_PAGE_CTA_LABEL_MAX_LENGTH),
				}),
			),
		).toBe(true);
		expect(
			Either.isLeft(
				decode({
					ctaUrl: over(PublicCollection.PUBLIC_PAGE_CTA_URL_MAX_LENGTH),
				}),
			),
		).toBe(true);
	});

	it("rejects values outside the literal unions", () => {
		expect(Either.isLeft(decode({ gridColumns: 7 }))).toBe(true);
		expect(Either.isLeft(decode({ layout: "carousel" }))).toBe(true);
		expect(Either.isLeft(decode({ logoMode: "remote" }))).toBe(true);
		expect(Either.isLeft(decode({ hideTitle: "yes" }))).toBe(true);
	});
});
