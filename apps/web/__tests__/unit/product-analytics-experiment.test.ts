import { describe, expect, it, vi } from "vitest";

const { trackEvent } = vi.hoisted(() => ({ trackEvent: vi.fn() }));

vi.mock("@/app/utils/analytics", () => ({ trackEvent }));

import {
	assignExperimentVariant,
	trackExperimentExposure,
} from "@/lib/analytics/experiment";

describe("experiment analytics", () => {
	it("assigns the same subject and version to a stable bounded variant", () => {
		const assignment = {
			experimentId: "pricing_headline",
			assignmentVersion: "v1",
			subjectId: "visitor-1",
			variants: ["control", "concise"] as const,
		};
		expect(assignExperimentVariant(assignment)).toBe(
			assignExperimentVariant(assignment),
		);
		expect(assignment.variants).toContain(assignExperimentVariant(assignment));
		expect(
			assignExperimentVariant({ ...assignment, variants: [] }),
		).toBeUndefined();
	});

	it("emits exposure once per assignment version and variant", () => {
		const values = new Map<string, string>();
		const storage = {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
		};
		const exposure = {
			experimentId: "pricing_headline",
			assignmentVersion: "v1",
			variant: "control",
		};

		expect(trackExperimentExposure(exposure, storage)).toBe(true);
		expect(trackExperimentExposure(exposure, storage)).toBe(false);
		expect(trackEvent).toHaveBeenCalledOnce();
		expect(trackEvent).toHaveBeenCalledWith("experiment_exposed", {
			experiment_id: "pricing_headline",
			variant: "control",
			assignment_version: "v1",
		});
	});
});
