import "server-only";

import { resumeHook } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import { isLoomImportSignalToken } from "@/lib/loom-import-signal-token";

export async function signalLoomImportFinished(
	token: string | null,
	videoId: string,
	phase: string,
) {
	if (!token || !isLoomImportSignalToken(token, videoId)) return;
	try {
		await resumeHook(token, { phase });
	} catch (error) {
		if (HookNotFoundError.is(error)) return;
		console.warn("[loom-import-signal] Could not wake the import", {
			videoId,
			error,
		});
	}
}
