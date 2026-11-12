import { billableVideo } from "@/lib/developer-pricing";
import {
	getInfraUploadAdmission,
	type InfraDbExecutor,
	type InfraUploadAdmission,
} from "@/lib/infra-standing";

export const DEVELOPER_VIDEO_MAX_DURATION_SECONDS = 4 * 60 * 60;

export type DeveloperVideoCharge =
	| "charged"
	| "insufficient"
	| "no-account"
	| { refused: string };

export type DeveloperVideoUpload = {
	appId: string;
	videoId: string;
	durationSeconds: number;
	width: number | null | undefined;
	height: number | null | undefined;
	maxResolutionTier: string | null;
	metadata?: Record<string, unknown>;
	executor?: InfraDbExecutor;
};

export function admitDeveloperVideoUpload(
	input: DeveloperVideoUpload,
): Promise<InfraUploadAdmission> {
	const video = billableVideo({
		duration: input.durationSeconds,
		width: input.width,
		height: input.height,
		maxResolutionTier: input.maxResolutionTier,
	});
	return getInfraUploadAdmission(input.appId, video, input.executor, {
		excludeVideoId: input.videoId,
	});
}

const dollars = (microCredits: number) =>
	`$${(Math.ceil(Math.max(0, microCredits) / 1000) / 100).toFixed(2)}`;

export async function chargeDeveloperVideoUpload(
	input: DeveloperVideoUpload,
): Promise<DeveloperVideoCharge> {
	const admission = await admitDeveloperVideoUpload(input);
	if (admission.allowed) return "charged";
	if (admission.reason === "no_account") return "no-account";
	return {
		refused: `Not enough credit to store this video at its measured length and size. Add at least ${dollars(admission.shortfallMicroCredits)} of credit and upload it again.`,
	};
}
