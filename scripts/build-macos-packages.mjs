import { spawn } from "node:child_process";
import { constants } from "node:os";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const desktopDirectory = fileURLToPath(
	new URL("../apps/desktop/", import.meta.url),
);
const retryDelays = [15_000, 30_000];
const outputTailLimit = 64 * 1024;

export function isTimestampSigningFailure(output) {
	const lines = stripVTControlCharacters(output)
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(
			(line) =>
				line &&
				!/^ELIFECYCLE\s+Command failed with exit code \d+\.$/.test(line),
		);
	const signingError =
		/^(?:Error\s+)?failed to bundle project: failed to sign app$/;
	if (!signingError.test(lines.pop() ?? "")) return false;
	while (signingError.test(lines.at(-1) ?? "")) lines.pop();
	return /^\/.+: (?:A timestamp was expected but was not found|The timestamp service is not available)\.$/.test(
		lines.at(-1) ?? "",
	);
}

function validateArguments(target, args, platform) {
	let valid =
		platform === "darwin" &&
		/^(?:aarch64|x86_64)-apple-darwin$/.test(target ?? "");
	for (let index = 0; index < args.length && valid; index++) {
		const argument = args[index];
		if (argument === "--config" || argument === "-c") {
			const value = args[++index];
			valid = Boolean(value) && !value.startsWith("-");
		} else {
			valid =
				/^--config=.+/.test(argument) ||
				argument === "--verbose" ||
				/^-v{1,2}$/.test(argument);
		}
	}
	if (!valid) {
		throw new Error(
			"Run on macOS: node scripts/build-macos-packages.mjs <aarch64|x86_64>-apple-darwin [--config <path>] [--verbose]",
		);
	}
}

export function executeMacosCommand(
	args,
	{ env, signal, onOutput, spawnProcess = spawn, killProcess = process.kill },
) {
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const child = spawnProcess("pnpm", args, {
			cwd: desktopDirectory,
			env,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let commandError;
		let killTimer;
		const terminate = (name) => {
			if (!child.pid) return;
			try {
				killProcess(-child.pid, name);
			} catch (error) {
				if (error.code !== "ESRCH") {
					commandError ??= error;
					child.kill(name);
				}
			}
		};
		const cancel = () => {
			terminate(signal.reason === "SIGINT" ? "SIGINT" : "SIGTERM");
			killTimer = setTimeout(() => terminate("SIGKILL"), 5_000);
			killTimer.unref();
		};
		for (const stream of ["stdout", "stderr"]) {
			child[stream].setEncoding("utf8");
			child[stream].on("data", (chunk) => onOutput(stream, chunk));
		}
		child.once("error", (error) => {
			commandError = error;
		});
		child.once("exit", (_code, childSignal) => {
			if (childSignal) terminate("SIGKILL");
		});
		child.once("close", (code, childSignal) => {
			signal?.removeEventListener("abort", cancel);
			clearTimeout(killTimer);
			if (signal?.aborted) {
				terminate("SIGKILL");
				reject(signal.reason);
			} else if (commandError) {
				reject(commandError);
			} else {
				resolve({ code, signal: childSignal });
			}
		});
		signal?.addEventListener("abort", cancel, { once: true });
		if (signal?.aborted) cancel();
	});
}

export async function buildMacosPackages(
	target,
	args = [],
	{
		platform = process.platform,
		env = process.env,
		signal,
		execute = executeMacosCommand,
		delay = (milliseconds, abortSignal) =>
			wait(milliseconds, undefined, { signal: abortSignal }),
		onOutput = (stream, chunk) => process[stream].write(chunk),
	} = {},
) {
	validateArguments(target, args, platform);
	const commandArguments = ["--target", target, ...args];
	const environment = { ...env, RUST_TARGET_TRIPLE: target };
	for (let attempt = 0; ; attempt++) {
		signal?.throwIfAborted();
		let outputTail = "";
		const command =
			attempt === 0
				? ["build:tauri", ...commandArguments]
				: [
						"exec",
						"dotenv",
						"-e",
						"../../.env",
						"--",
						"pnpm",
						"tauri",
						"bundle",
						...commandArguments,
					];
		const result = await execute(command, {
			env: environment,
			signal,
			onOutput: (stream, chunk) => {
				outputTail = (outputTail + chunk).slice(-outputTailLimit);
				onOutput(stream, chunk);
			},
		});
		signal?.throwIfAborted();
		if (result.error) throw result.error;
		if (
			!Number.isInteger(result.code) ||
			result.code <= 0 ||
			result.code >= 128 ||
			result.signal ||
			attempt === retryDelays.length ||
			!isTimestampSigningFailure(outputTail)
		) {
			return result;
		}
		onOutput(
			"stderr",
			`Secure timestamp signing failed; retrying macOS packaging in ${retryDelays[attempt] / 1_000}s (${attempt + 1}/${retryDelays.length}).\n`,
		);
		await delay(retryDelays[attempt], signal);
	}
}

async function main() {
	const controller = new AbortController();
	const interrupt = () => controller.abort("SIGINT");
	const terminate = () => controller.abort("SIGTERM");
	process.on("SIGINT", interrupt);
	process.on("SIGTERM", terminate);
	try {
		const [target, ...args] = process.argv.slice(2);
		const result = await buildMacosPackages(target, args, {
			signal: controller.signal,
		});
		process.exitCode = result.signal
			? 128 + (constants.signals[result.signal] ?? 1)
			: (result.code ?? 1);
	} catch (error) {
		if (!controller.signal.aborted) throw error;
		process.exitCode = 128 + constants.signals[controller.signal.reason];
	} finally {
		process.removeListener("SIGINT", interrupt);
		process.removeListener("SIGTERM", terminate);
	}
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	main().catch((error) => {
		console.error(error?.message ?? error);
		process.exitCode = 1;
	});
}
