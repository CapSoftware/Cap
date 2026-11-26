const MAX_FFMPEG_ERROR_LINES = 3;
const ERROR_LINE_PATTERN =
	/error|invalid|failed|unsupported|cannot|unknown|unrecognized|not found|no such|no capable|reconfiguring/i;
const PROGRESS_LINE_PATTERN = /^\s*[\w.]+=\S*\s*$/;

export class FfmpegExitError extends Error {
	constructor(
		message: string,
		readonly errorLines: string[],
	) {
		super(message);
	}
}

function isFfmpegErrorLine(line: string): boolean {
	return ERROR_LINE_PATTERN.test(line) && !PROGRESS_LINE_PATTERN.test(line);
}

export function collectFfmpegErrorLine(errorLines: string[], line: string) {
	if (errorLines.length < MAX_FFMPEG_ERROR_LINES && isFfmpegErrorLine(line))
		errorLines.push(line.trim());
}

export function ffmpegErrorLines(stderr: string): string[] {
	const errorLines: string[] = [];
	for (const line of stderr.split(/\r\n|\r|\n/)) {
		collectFfmpegErrorLine(errorLines, line);
	}
	return errorLines;
}

export class EncodeStalledError extends Error {
	constructor(idleMs: number) {
		super(
			`Encoding stalled: no progress for ${Math.round(idleMs / 1000)} seconds`,
		);
		this.name = "EncodeStalledError";
	}
}

// A stall or a timeout says nothing about the encoder, so another encoder is
// not tried for it.
export function isEncodeDeadlineError(error: unknown): boolean {
	return (
		error instanceof EncodeStalledError ||
		(error instanceof Error &&
			/^Operation timed out after \d+ms/.test(error.message))
	);
}
