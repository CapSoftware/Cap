// `bun run dev:desktop`: Cap's desktop app (apps/desktop-gpui) from source.
// macOS runs the save-to-relaunch loop in apps/desktop-gpui/dev.sh, which
// relies on BSD stat/md5; Windows and Linux build and run the app once.
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const gpuiDir = path.join(repoRoot, "apps", "desktop-gpui");

// setup.js copies the FFmpeg and ONNX Runtime libraries into the root
// workspace's target/, which is not where cargo puts this app's binary.
function runtimeEnvironment(env) {
	const prepend = (name, directories) => {
		// Windows spells it `Path`; a second `PATH` key would shadow it.
		const key =
			Object.keys(env).find((existing) => existing.toUpperCase() === name) ??
			name;
		return {
			...env,
			[key]: [...directories, env[key]].filter(Boolean).join(path.delimiter),
		};
	};
	if (process.platform === "win32") {
		return prepend("PATH", [path.join(repoRoot, "target", "debug")]);
	}
	if (process.platform === "linux") {
		return prepend("LD_LIBRARY_PATH", [
			path.join(repoRoot, "target", "native-deps", "lib"),
			path.join(repoRoot, "target", "debug"),
		]);
	}
	return env;
}

function main() {
	const prepared = spawnSync(
		"bash",
		[path.join(repoRoot, "scripts", "prepare-gpui-dependency.sh")],
		{ stdio: "inherit" },
	);
	if (prepared.error) throw prepared.error;
	if (prepared.status !== 0) process.exit(prepared.status ?? 1);

	const child =
		process.platform === "darwin"
			? spawn("bash", [path.join(gpuiDir, "dev.sh")], {
					cwd: gpuiDir,
					stdio: "inherit",
				})
			: spawn("cargo", ["run"], {
					cwd: gpuiDir,
					stdio: "inherit",
					env: runtimeEnvironment(process.env),
				});

	for (const signal of ["SIGINT", "SIGTERM"]) {
		process.on(signal, () => child.kill(signal));
	}
	child.on("exit", (code, signal) => {
		if (signal) {
			process.removeAllListeners(signal);
			process.kill(process.pid, signal);
		} else process.exit(code ?? 1);
	});
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	main();
}
