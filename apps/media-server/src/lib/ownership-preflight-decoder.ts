import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { verifyOwnershipPreflightRecording } from "./recording-verification";

const probeSchema = z
	.object({
		programs: z.array(z.never()).max(0).optional(),
		stream_groups: z.array(z.never()).max(0).optional(),
		streams: z
			.array(
				z
					.object({
						codec_type: z.enum(["video", "audio"]),
						width: z.number().int().positive().max(8192).optional(),
						height: z.number().int().positive().max(8192).optional(),
						channels: z.number().int().positive().max(8).optional(),
						sample_rate: z.string().regex(/^\d+$/).optional(),
					})
					.strict(),
			)
			.min(1)
			.max(2),
		format: z.object({ format_name: z.string() }).strict(),
	})
	.strict();

async function probe(path: string, signal: AbortSignal) {
	if (!isAbsolute(path)) throw new Error("Invalid preflight input");
	const child = spawn(
		"prlimit",
		[
			"--as=536870912",
			"--cpu=30",
			"--nofile=32",
			"--",
			"ffprobe",
			"-v",
			"error",
			"-err_detect",
			"explode",
			"-protocol_whitelist",
			"file",
			"-f",
			"mov",
			"-enable_drefs",
			"0",
			"-use_absolute_path",
			"0",
			"-show_entries",
			"stream=codec_type,width,height,channels,sample_rate:format=format_name",
			"-of",
			"json",
			path,
		],
		{
			stdio: ["ignore", "pipe", "pipe"],
			env: { PATH: process.env.PATH, LANG: "C" },
		},
	);
	const stop = () => child.kill("SIGKILL");
	const exited = new Promise<number>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve(code ?? -1));
	});
	const timeout = setTimeout(stop, 30_000);
	signal.addEventListener("abort", stop, { once: true });
	let output = "";
	let diagnostics = false;
	child.stderr.on("data", () => {
		diagnostics = true;
	});
	try {
		if (signal.aborted) stop();
		for await (const bytes of child.stdout) {
			output += bytes.toString();
			if (output.length > 128 * 1024) throw new Error("Preflight probe limit");
		}
		if ((await exited) !== 0 || diagnostics || signal.aborted)
			throw new Error("Preflight probe failed");
		const result = probeSchema.parse(JSON.parse(output));
		const video = result.streams.filter(
			(stream) => stream.codec_type === "video",
		);
		const audio = result.streams.filter(
			(stream) => stream.codec_type === "audio",
		);
		if (
			!result.format.format_name.split(",").includes("mp4") ||
			video.length !== 1 ||
			audio.length > 1 ||
			!video[0]?.width ||
			!video[0]?.height ||
			video[0].width * video[0].height > 33_554_432 ||
			audio.some(
				(stream) =>
					!stream.channels ||
					!stream.sample_rate ||
					Number(stream.sample_rate) > 192_000,
			)
		)
			throw new Error("Unsupported preflight media");
		return { hasAudio: audio.length === 1 };
	} finally {
		clearTimeout(timeout);
		signal.removeEventListener("abort", stop);
		stop();
		await exited.catch(() => {});
	}
}

export async function decodeOwnershipPreflightFile(
	path: string,
	expectedDuration: number | null,
	signal: AbortSignal,
	timeoutMs: number,
) {
	const { hasAudio } = await probe(path, signal);
	const decoded = await verifyOwnershipPreflightRecording(path, {
		expectedDuration: expectedDuration ?? undefined,
		allowObservedDuration: expectedDuration === null,
		requireAudio: hasAudio,
		hasAudio,
		abortSignal: signal,
		timeoutMs,
	});
	if (!decoded.integrity) throw new Error("Missing preflight integrity");
	return { ...decoded, integrity: decoded.integrity };
}
