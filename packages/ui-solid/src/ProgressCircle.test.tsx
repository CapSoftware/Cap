import { renderToString } from "solid-js/web";
import { describe, expect, it } from "vitest";
import { ProgressCircle } from "./ProgressCircle";

describe("ProgressCircle", () => {
	it("renders accessible progress values", () => {
		const markup = renderToString(() => (
			<ProgressCircle progress={42} size="lg" variant="primary" />
		));

		expect(markup).toContain('role="progressbar"');
		expect(markup).toContain('aria-valuenow="42"');
		expect(markup).toContain('aria-valuemin="0"');
		expect(markup).toContain('aria-valuemax="100"');
		expect(markup).toContain("stroke-blue-10");
		expect(markup).toContain("stroke-blue-5");
	});

	it("clamps progress before rendering aria state and stroke offset", () => {
		const overMaxMarkup = renderToString(() => (
			<ProgressCircle progress={125} strokeWidth={4} />
		));
		const belowMinMarkup = renderToString(() => (
			<ProgressCircle progress={-20} strokeWidth={4} />
		));

		expect(overMaxMarkup).toContain('aria-valuenow="100"');
		expect(overMaxMarkup).toContain('stroke-dashoffset="0"');
		expect(belowMinMarkup).toContain('aria-valuenow="0"');
		expect(belowMinMarkup).toContain('stroke-dashoffset="37.69911184307752"');
	});
});
