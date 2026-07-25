import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dryRun = process.env.CAP_MOBILE_DRY_RUN === "1";

const run = (command, args) => {
	if (dryRun) {
		console.log(`${command} ${args.join(" ")}`);
		return;
	}

	const result = spawnSync(command, args, {
		stdio: "inherit",
		env: process.env,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
};

run("pnpm", ["exec", "expo", "prebuild", "--platform", "ios", "--no-install"]);

const podfileLockPath = join(process.cwd(), "ios", "Podfile.lock");
const podfileLock = existsSync(podfileLockPath)
	? readFileSync(podfileLockPath, "utf8")
	: "";
const podsManifestPath = join(process.cwd(), "ios", "Pods", "Manifest.lock");
const podsManifest = existsSync(podsManifestPath)
	? readFileSync(podsManifestPath, "utf8")
	: "";
const needsPodInstall =
	!podfileLock ||
	podfileLock !== podsManifest ||
	podfileLock.includes("React-Core-prebuilt") ||
	podfileLock.includes("ReactNativeDependencies") ||
	!podfileLock.includes("ExpoAppleAuthentication");

if (needsPodInstall) {
	run("pod", ["install", "--project-directory=ios"]);
}
