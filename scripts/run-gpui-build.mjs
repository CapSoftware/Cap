import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export function shouldBuildGpui(
	platform,
	environment,
	profile,
	developmentWorkspaceAvailable = true,
) {
	if (!["darwin", "win32", "linux"].includes(platform)) return false;
	if (profile === "release") return true;
	return (
		platform === "darwin" &&
		environment.CAP_GPUI_DEV !== "0" &&
		developmentWorkspaceAvailable
	);
}

export function shouldBundleGpui(
	platform,
	environment,
	profile,
	stagedSidecarAvailable,
	developmentWorkspaceAvailable = true,
) {
	return (
		shouldBuildGpui(
			platform,
			environment,
			profile,
			developmentWorkspaceAvailable,
		) &&
		(profile === "release" || stagedSidecarAvailable)
	);
}

function main() {
	const profile = process.argv[2];
	if (profile !== "debug" && profile !== "release") {
		console.error("The Cap GPUI build profile must be debug or release.");
		process.exitCode = 1;
		return;
	}

	const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
	const gpuiDevScript = path.join(
		scriptsDir,
		"..",
		"apps",
		"desktop-gpui",
		"dev.sh",
	);

	if (
		!shouldBuildGpui(
			process.platform,
			process.env,
			profile,
			profile !== "debug" || existsSync(gpuiDevScript),
		)
	) {
		console.log(
			`Skipping Cap GPUI ${profile} build on ${process.platform}${
				process.env.CAP_GPUI_DEV === "0" ? " because CAP_GPUI_DEV=0" : ""
			}.`,
		);
		return;
	}

	const result = spawnSync(
		"bash",
		[path.join(scriptsDir, "build-gpui-binary.sh"), profile],
		{ stdio: "inherit" },
	);

	if (result.error) {
		console.error(`Failed to build Cap GPUI: ${result.error.message}`);
		process.exitCode = 1;
	} else if (result.status !== 0) {
		process.exitCode = result.status ?? 1;
	}
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	main();
}
