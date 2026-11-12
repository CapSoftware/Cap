import { billableVideo } from "@/lib/developer-pricing";
import {
	getInfraUploadAdmission,
	type InfraDbExecutor,
	type InfraUploadAdmission,
} from "@/lib/infra-standing";

export const DEVELOPER_VIDEO_MAX_DURATION_SECONDS = 4 * 60 * 60;

export type DeveloperVideoCharge = "charged" | "insufficient" | "no-account";

export type DeveloperVideoUpload = {
	appId: string;
	videoId: string;
	durationSeconds: number;
	width?: number | null;
	height?: number | null;
	maxResolutionTier?: string | null;
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

export async function chargeDeveloperVideoUpload(
	input: DeveloperVideoUpload,
): Promise<DeveloperVideoCharge> {
	const admission = await admitDeveloperVideoUpload(input);
	if (admission.allowed) return "charged";
	return admission.reason === "no_account" ? "no-account" : "insufficient";
}
