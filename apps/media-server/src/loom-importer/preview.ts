import { z } from "zod";
import { generatePreviewGif, uploadFileToS3 } from "../lib/media-video";

const PREVIEW_TIMEOUT_MS = 120_000;

export const previewRequestSchema = z.object({
	videoUrl: z
		.string()
		.url()
		.refine((value) => value.startsWith("https://"), "videoUrl must use HTTPS"),
	previewGifPresignedUrl: z.string().url(),
	duration: z.number().positive().max(86_400),
});

export type PreviewRequest = z.infer<typeof previewRequestSchema>;

export async function renderPreviewGif(request: PreviewRequest) {
	const signal = AbortSignal.timeout(PREVIEW_TIMEOUT_MS);
	const rendered = await generatePreviewGif(
		request.videoUrl,
		request.duration,
		{},
		signal,
	);
	try {
		await uploadFileToS3(
			rendered.path,
			request.previewGifPresignedUrl,
			"image/gif",
			signal,
		);
	} finally {
		await rendered.cleanup();
	}
}
