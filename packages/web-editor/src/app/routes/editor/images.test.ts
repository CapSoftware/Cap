import { describe, expect, it } from "vitest";
import {
	defaultImageSegment,
	fitImageSize,
	imageAssetPath,
	resizeImage,
} from "./images";

describe("image import", () => {
	it("rejects paths outside project image assets", () => {
		expect(imageAssetPath("/project.cap", "content/images/a.png")).toBe(
			"/project.cap/content/images/a.png",
		);
		for (const path of [
			"/original/a.png",
			"../a.png",
			"content/images/../a.png",
			"content/images/sub/a.png",
		])
			expect(imageAssetPath("/project.cap", path)).toBeNull();
	});
});

describe("image geometry", () => {
	it("normalizes the oriented image to the output aspect without distortion", () => {
		const size = fitImageSize(400, 600, 1920, 1080);
		expect(size.y).toBeCloseTo(0.3);
		expect((size.x * 1920) / (size.y * 1080)).toBeCloseTo(400 / 600);
		const segment = defaultImageSegment(
			{ path: "content/images/a.png", name: "A", width: 400, height: 600 },
			1,
			4,
			2,
			{ width: 1920, height: 1080 },
		);
		expect(segment).toMatchObject({
			start: 1,
			end: 4,
			track: 2,
			center: { x: 0.5, y: 0.5 },
			opacity: 1,
			rotation: 0,
			lockAspect: true,
		});
	});

	it.each([0, 45, 90, -135])(
		"preserves aspect and the opposite corner at rotation %s",
		(rotation) => {
			const canvas = { width: 1000, height: 600 };
			const segment = {
				center: { x: 0.5, y: 0.5 },
				size: { x: 0.2, y: 0.2 },
				rotation,
				lockAspect: true,
			};
			const resized = resizeImage(
				segment,
				{ x: 30, y: 45 },
				{ x: 1, y: 1 },
				canvas,
			);
			expect(resized.size.x / resized.size.y).toBeCloseTo(1);
			const opposite = (image: typeof resized) => {
				const radians = (rotation * Math.PI) / 180;
				const x = (-image.size.x * canvas.width) / 2;
				const y = (-image.size.y * canvas.height) / 2;
				return {
					x:
						image.center.x * canvas.width +
						x * Math.cos(radians) -
						y * Math.sin(radians),
					y:
						image.center.y * canvas.height +
						x * Math.sin(radians) +
						y * Math.cos(radians),
				};
			};
			expect(opposite(resized).x).toBeCloseTo(opposite(segment).x);
			expect(opposite(resized).y).toBeCloseTo(opposite(segment).y);
		},
	);
});
