import { runInfraVideoImport } from "@/lib/infra-video-import";

export async function importDeveloperVideoWorkflow({
	videoId,
}: {
	videoId: string;
}): Promise<"complete" | "failed" | "skipped"> {
	"use workflow";

	return downloadImportedVideo(videoId);
}

async function downloadImportedVideo(
	videoId: string,
): Promise<"complete" | "failed" | "skipped"> {
	"use step";

	return runInfraVideoImport(videoId);
}

// The step records every outcome itself. A second run only happens when the
// function was stopped mid-download, and that run finishes the import as
// timed out once the first download's time is up.
downloadImportedVideo.maxRetries = 1;
