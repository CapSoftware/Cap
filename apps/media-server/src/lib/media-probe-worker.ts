import type { WorkerResponse } from "./isolated-worker-pool";
import { MediaAddressError } from "./media-address-guard";
import { MediaInputPolicyError } from "./media-input-policy";
import type {
	ProbeWorkerFailure,
	ProbeWorkerRequest,
} from "./media-probe-pool";
import {
	computeTrackSpans,
	MediaInputNotAccessibleError,
	measureFastestFrameRate,
	PARSER_FAULT_EXIT_CODE,
	probeMedia,
	UnreadableMediaInputError,
} from "./media-probe-read";

function describe(error: unknown): ProbeWorkerFailure {
	const message = error instanceof Error ? error.message : String(error);
	if (error instanceof MediaInputPolicyError)
		return { kind: "policy", message };
	if (error instanceof MediaAddressError) return { kind: "address", message };
	if (error instanceof MediaInputNotAccessibleError) {
		return { kind: "not-accessible", message, status: error.status };
	}
	if (error instanceof UnreadableMediaInputError) {
		const cause = error.cause;
		return {
			kind: "unreadable",
			message,
			...(cause !== undefined && {
				cause: cause instanceof Error ? cause.message : String(cause),
			}),
		};
	}
	if (error instanceof Error && error.name === "UnsupportedInputFormatError") {
		return { kind: "unsupported-format", message };
	}
	return { kind: "error", message };
}

async function run(request: ProbeWorkerRequest): Promise<unknown> {
	// The server reads this on every request, so a worker started earlier
	// follows it too.
	if (request.internalMediaHosts === null) {
		delete process.env.MEDIA_SERVER_INTERNAL_MEDIA_HOSTS;
	} else {
		process.env.MEDIA_SERVER_INTERNAL_MEDIA_HOSTS = request.internalMediaHosts;
	}
	if (request.op === "metadata") return await probeMedia(request.path);
	if (request.op === "trackSpans") return await computeTrackSpans(request.path);
	return await measureFastestFrameRate(request.path);
}

function reply(response: WorkerResponse<ProbeWorkerFailure>): void {
	process.send?.(response);
}

process.on("message", (request: ProbeWorkerRequest) => {
	run(request).then(
		(value) => reply({ id: request.id, ok: true, value }),
		(error) => reply({ id: request.id, ok: false, error: describe(error) }),
	);
});

// A fault inside the parser that escapes the request (a rejection it left
// behind, a throw from a timer) ends this worker, not the server.
process.on("uncaughtException", () => process.exit(PARSER_FAULT_EXIT_CODE));
process.on("unhandledRejection", () => {});
process.on("disconnect", () => process.exit(0));

reply({ id: 0, ok: true, value: "ready" });
