import { COMPRESSION_BPP, type JobRequest } from "./protocol";

/** Rejects malformed or out-of-range export requests before any work starts. */
export function validateJobRequest(body: unknown): JobRequest | string {
	if (!body || typeof body !== "object") return "body must be a JSON object";
	const request = body as Record<string, unknown>;
	const recording = request.recording;
	if (
		typeof recording !== "string" ||
		!/^[A-Za-z0-9._/-]{1,512}$/.test(recording) ||
		recording.split("/").includes("..")
	) {
		return "recording must be a bucket prefix";
	}
	const integer = (value: unknown, min: number, max: number) =>
		value === undefined ||
		(typeof value === "number" &&
			Number.isInteger(value) &&
			value >= min &&
			value <= max);
	const positive = (value: unknown, max: number) =>
		value === undefined ||
		(typeof value === "number" &&
			Number.isFinite(value) &&
			value > 0 &&
			value <= max);
	if (!integer(request.fps, 1, 120))
		return "fps must be an integer from 1 to 120";
	const resolution = request.resolution;
	if (
		resolution !== undefined &&
		!(
			Array.isArray(resolution) &&
			resolution.length === 2 &&
			integer(resolution[0], 16, 7680) &&
			integer(resolution[1], 16, 4320)
		)
	) {
		return "resolution must be [width, height] within 16..7680 x 16..4320";
	}
	if (
		request.compression !== undefined &&
		!(
			typeof request.compression === "string" &&
			request.compression in COMPRESSION_BPP
		)
	) {
		return `compression must be one of ${Object.keys(COMPRESSION_BPP).join(", ")}`;
	}
	for (const [field, max] of [
		["maxChunks", 5000],
		["chunks", 5000],
		["chunksPerSlot", 64],
		["frameLimit", 10_000_000],
	] as const) {
		if (!integer(request[field], 1, max))
			return `${field} must be an integer from 1 to ${max}`;
	}
	for (const [field, max] of [
		["minChunkSeconds", 600],
		["chunkWorkSeconds", 600],
	] as const) {
		if (!positive(request[field], max))
			return `${field} must be a positive number up to ${max}`;
	}
	if (
		request.label !== undefined &&
		(typeof request.label !== "string" || request.label.length > 200)
	) {
		return "label must be a string of at most 200 characters";
	}
	if (
		request.duplicateStragglers !== undefined &&
		typeof request.duplicateStragglers !== "boolean"
	) {
		return "duplicateStragglers must be a boolean";
	}
	return request as JobRequest;
}
