import {
	type ExecFileOptionsWithStringEncoding,
	execFile,
} from "node:child_process";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const EDITOR_PROCESS_ENV_KEYS = [
	"PATH",
	"TMPDIR",
	"TEMP",
	"TMP",
	"LANG",
	"LC_ALL",
	"LD_LIBRARY_PATH",
	"DYLD_LIBRARY_PATH",
	"DYLD_FALLBACK_LIBRARY_PATH",
	"FONTCONFIG_PATH",
	"FONTCONFIG_FILE",
	"XDG_CACHE_HOME",
	"XDG_RUNTIME_DIR",
	"VK_ICD_FILENAMES",
	"VK_LAYER_PATH",
	"ORT_DYLIB_PATH",
	"CAP_RENDER_FORCE_SOFTWARE_ADAPTER",
	"CAP_EDITOR_FORCE_FFMPEG_DECODER",
	"CAP_EXPORT_DISABLE_ZERO_COPY",
	"CAP_EXPORT_FORCE_SOFTWARE_ENCODER",
	"CAP_DISABLE_ENCODER_SELF_TEST",
] as const;

export function editorProcessEnv(
	internalToken?: string,
	projectRoot?: string,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const name of EDITOR_PROCESS_ENV_KEYS) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	if (internalToken !== undefined) {
		env.CAP_WEB_EDITOR_INTERNAL_TOKEN = internalToken;
	}
	if (projectRoot !== undefined) {
		env.CAP_WEB_EDITOR_PROJECT_ROOT = projectRoot;
	}
	return env;
}

export function runEditorFile(
	file: string,
	args: string[],
	options: ExecFileOptionsWithStringEncoding = {},
) {
	return runFile(file, args, {
		...options,
		encoding: "utf8",
		env: editorProcessEnv(),
	});
}
