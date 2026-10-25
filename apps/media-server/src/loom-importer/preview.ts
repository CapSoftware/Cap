import { z } from "zod";
import { generatePreviewGif, uploadFileToS3 } from "../lib/media-video";

export const previewRequestSchema = z.object({
	videoUrl: z
		.string()
		.url()
		.refine(
			(value) => value.startsWith("https://") || value.startsWith("http://"),
			"videoUrl must be an HTTP URL",
		),
	previewGifPresignedUrl: z.string().url(),
	duration: z.number().positive().max(86_400),
});

export type PreviewRequest = z.infer<typeof previewRequestSchema>;

export async function renderPreviewGif(
	request: PreviewRequest,
	signal: AbortSignal,
) {
	signal.throwIfAborted();
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
