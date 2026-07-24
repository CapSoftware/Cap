import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const readSimulators = () => {
	const result = spawnSync(
		"xcrun",
		["simctl", "list", "devices", "available", "--json"],
		{
			encoding: "utf8",
		},
	);
	if (result.status !== 0) {
		throw new Error(result.stderr || "Unable to list iOS simulators");
	}

	return JSON.parse(result.stdout);
};

const availableIphones = () =>
	Object.values(readSimulators().devices ?? {})
		.flat()
		.filter(
			(device) => device?.isAvailable && device?.name?.includes("iPhone"),
		);

const findSimulator = () => {
	const requestedUdid = process.env.IOS_SIMULATOR_UDID;
	const requestedName = process.env.IOS_SIMULATOR_DEVICE;
	const devices = availableIphones();

	if (requestedUdid) {
		const requested = devices.find((device) => device.udid === requestedUdid);
		if (requested) return requested;
		throw new Error(`No available iPhone simulator found for ${requestedUdid}`);
	}

	if (requestedName) {
		const requested = devices.find((device) => device.name === requestedName);
		if (requested) return requested;
		throw new Error(`No available iPhone simulator named ${requestedName}`);
	}

	const booted = devices.find((device) => device.state === "Booted");
	if (booted) return booted;

	const preferred = devices.find((device) => device.name.includes("Pro"));
	return preferred ?? devices[0] ?? null;
};

const findSimulatorByUdid = (udid) =>
	availableIphones().find((device) => device.udid === udid) ?? null;

const ensureSimulatorReady = (device) => {
	if (device.state !== "Booted") {
		console.log(`Booting iOS simulator: ${device.name} (${device.udid})`);
		const boot = spawnSync("xcrun", ["simctl", "boot", device.udid], {
			encoding: "utf8",
		});
		if (boot.status !== 0) {
			const current = findSimulatorByUdid(device.udid);
			if (current?.state !== "Booted" && current?.state !== "Booting") {
				throw new Error(boot.stderr || `Unable to boot ${device.name}`);
			}
		}
	}

	const ready = spawnSync(
		"xcrun",
		["simctl", "bootstatus", device.udid, "-b"],
		{ stdio: "inherit" },
	);
	if (ready.status !== 0) {
		throw new Error(`Simulator did not finish booting: ${device.name}`);
	}
};

const simulator = findSimulator();
if (!simulator) {
	throw new Error("No available iPhone simulators found");
}

const needsDevPrebuild = () => {
	if (existsSync(join(process.cwd(), "ios", "CapBroadcastExtension"))) {
		return true;
	}
	const entitlementsPath = join(
		process.cwd(),
		"ios",
		"Cap",
		"Cap.entitlements",
	);
	if (!existsSync(entitlementsPath)) return true;
	const entitlements = readFileSync(entitlementsPath, "utf8");
	return entitlements.includes("com.apple.developer.associated-domains");
};

const command = ["exec", "expo", "run:ios", "--device", simulator.udid];
console.log(`Using iOS simulator: ${simulator.name} (${simulator.udid})`);

if (process.env.CAP_MOBILE_DRY_RUN === "1") {
	console.log(`pnpm ${command.join(" ")}`);
	process.exit(0);
}

ensureSimulatorReady(simulator);

if (
	process.env.CAP_MOBILE_DISABLE_ASSOCIATED_DOMAINS === "1" &&
	needsDevPrebuild()
) {
	const prebuild = spawnSync(
		"pnpm",
		[
			"exec",
			"expo",
			"prebuild",
			"--platform",
			"ios",
			"--no-install",
			"--clean",
		],
		{
			stdio: "inherit",
			env: process.env,
		},
	);
	if (prebuild.status !== 0) {
		process.exit(prebuild.status ?? 1);
	}
}

const runExpo = () =>
	spawnSync("pnpm", command, {
		stdio: "inherit",
		env: process.env,
	});

let result = runExpo();
if (result.status !== 0) {
	const current = findSimulatorByUdid(simulator.udid);
	if (current && current.state !== "Booted") {
		console.warn(
			`iOS simulator stopped while Expo was launching. Rebooting ${current.name} and retrying once.`,
		);
		ensureSimulatorReady(current);
		result = runExpo();
	}
}

process.exit(result.status ?? 1);
