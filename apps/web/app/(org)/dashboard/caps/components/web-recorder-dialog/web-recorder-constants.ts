import type { DetectedDisplayRecordingMode } from "@cap/recorder-core/recorder-constants";
import { Video } from "@cap/web-domain";
import type { RecordingMode } from "./RecordingModeSelector";

export * from "@cap/recorder-core/recorder-constants";

// Derived here rather than in @cap/recorder-core so the framework-agnostic
// package carries no runtime dependency on the @cap/web-domain barrel (the
// extension bundles recorder-core and must not pull effect along with it).
export const FREE_PLAN_MAX_RECORDING_MS =
	Video.FREE_PLAN_MAX_RECORDING_SECONDS * 1000;

// Compile-time guard: recorder-core can't import RecordingModeSelector, so it
// hand-writes DetectedDisplayRecordingMode. Fail the build if the two unions
// ever diverge.
type MutuallyAssignable<A, B> = [A] extends [B]
	? [B] extends [A]
		? true
		: never
	: never;
const _detectedDisplayRecordingModeStaysInSync: MutuallyAssignable<
	DetectedDisplayRecordingMode,
	Exclude<RecordingMode, "camera">
> = true;
void _detectedDisplayRecordingModeStaysInSync;

export const dialogVariants = {
	hidden: {
		opacity: 0,
		scale: 0.9,
		y: 20,
	},
	visible: {
		opacity: 1,
		scale: 1,
		y: 0,
		transition: {
			type: "spring",
			duration: 0.4,
			damping: 25,
			stiffness: 500,
		},
	},
	exit: {
		opacity: 0,
		scale: 0.95,
		y: 10,
		transition: {
			duration: 0.2,
		},
	},
};
