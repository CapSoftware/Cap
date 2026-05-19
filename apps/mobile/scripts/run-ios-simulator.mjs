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

const findSimulator = () => {
	const requestedUdid = process.env.IOS_SIMULATOR_UDID;
	const requestedName = process.env.IOS_SIMULATOR_DEVICE;
	const data = readSimulators();
	const devices = Object.values(data.devices ?? {})
		.flat()
		.filter(
			(device) => device?.isAvailable && device?.name?.includes("iPhone"),
		);

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

const result = spawnSync("pnpm", command, {
	stdio: "inherit",
	env: process.env,
});

process.exit(result.status ?? 1);
