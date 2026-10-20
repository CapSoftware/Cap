import { probeVideoFile } from "../../../apps/media-server/src/lib/media-probe";
import { processVideo } from "../../../apps/media-server/src/lib/media-video";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
	console.error("usage: bun media-server-driver.ts <input> <output.mp4>");
	process.exit(2);
}
const metadata = await probeVideoFile(input);
const started = performance.now();
const result = await processVideo(input, metadata, {});
const elapsed = performance.now() - started;
await Bun.write(output, Bun.file(result.path));
await result.cleanup();
console.log(
	JSON.stringify({
		encoder: process.env.CAP_MEDIA_VIDEO_ENCODER ?? "libx264",
		elapsedMs: elapsed,
		metadata,
	}),
);
