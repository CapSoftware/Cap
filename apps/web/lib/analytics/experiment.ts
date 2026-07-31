import { trackEvent } from "@/app/utils/analytics";

export interface ExperimentAssignment {
	experimentId: string;
	assignmentVersion: string;
	subjectId: string;
	variants: readonly string[];
}

export interface ExperimentExposure {
	experimentId: string;
	assignmentVersion: string;
	variant: string;
}

export function assignExperimentVariant({
	experimentId,
	assignmentVersion,
	subjectId,
	variants,
}: ExperimentAssignment) {
	if (variants.length === 0) return undefined;
	const input = `${experimentId}\u0000${assignmentVersion}\u0000${subjectId}`;
	let hash = 2166136261;
	for (let index = 0; index < input.length; index += 1) {
		hash = Math.imul(hash ^ input.charCodeAt(index), 16777619);
	}
	return variants[(hash >>> 0) % variants.length];
}

export function trackExperimentExposure(
	{ experimentId, assignmentVersion, variant }: ExperimentExposure,
	storage: Pick<Storage, "getItem" | "setItem"> | undefined = typeof window ===
	"undefined"
		? undefined
		: window.localStorage,
) {
	const storageKey = `cap_experiment_exposure:${experimentId}:${assignmentVersion}`;
	try {
		if (storage?.getItem(storageKey) === variant) return false;
	} catch {}

	trackEvent("experiment_exposed", {
		experiment_id: experimentId,
		variant,
		assignment_version: assignmentVersion,
	});
	try {
		storage?.setItem(storageKey, variant);
	} catch {}
	return true;
}
