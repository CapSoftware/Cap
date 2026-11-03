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
