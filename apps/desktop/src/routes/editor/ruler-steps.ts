const RULER_STEPS = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000];
const MIN_MAJOR_TICK_PX = 56;

export function rulerStep(pixelsPerUnit: number) {
	return (
		RULER_STEPS.find((step) => step * pixelsPerUnit >= MIN_MAJOR_TICK_PX) ??
		RULER_STEPS[RULER_STEPS.length - 1]
	);
}

if (import.meta.vitest) {
	const { expect, it } = import.meta.vitest;

	it("picks a ruler step that keeps major ticks readable", () => {
		expect(rulerStep(0.25)).toBe(250);
		expect(rulerStep(1)).toBe(100);
		expect(rulerStep(0.05)).toBe(2000);
	});
}
