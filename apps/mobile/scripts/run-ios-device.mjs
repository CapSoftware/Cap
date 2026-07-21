import { spawnSync } from "node:child_process";
import { networkInterfaces } from "node:os";

const isPrivateIpv4 = ({ address, family, internal }) =>
	family === "IPv4" &&
	!internal &&
	(address.startsWith("10.") ||
		address.startsWith("192.168.") ||
		/^172\.(1[6-9]|2\d|3[01])\./.test(address));

const findLanAddress = () => {
	const interfaces = networkInterfaces();
	for (const name of ["en0", "en1"]) {
		const address = interfaces[name]?.find(isPrivateIpv4)?.address;
		if (address) return address;
	}

	return Object.values(interfaces)
		.flat()
		.find((address) => address && isPrivateIpv4(address))?.address;
};

const lanAddress = process.env.CAP_MOBILE_LAN_IP ?? findLanAddress();
const localApiPort = process.env.CAP_MOBILE_LOCAL_API_PORT ?? "3000";
const apiBaseUrl =
	process.env.EXPO_PUBLIC_CAP_WEB_URL ??
	(lanAddress ? `http://${lanAddress}:${localApiPort}` : null);

if (!apiBaseUrl) {
	throw new Error(
		"Unable to find the Mac LAN address. Set EXPO_PUBLIC_CAP_WEB_URL explicitly.",
	);
}

const forwardedArgs = process.argv.slice(2);
if (forwardedArgs[0] === "--") forwardedArgs.shift();
const command = ["exec", "expo", "run:ios", "--device", ...forwardedArgs];
console.log(`Using Cap API: ${apiBaseUrl}`);

if (process.env.CAP_MOBILE_DRY_RUN === "1") {
	console.log(`pnpm ${command.join(" ")}`);
	process.exit(0);
}

const result = spawnSync("pnpm", command, {
	stdio: "inherit",
	env: {
		...process.env,
		CAP_MOBILE_DISABLE_ASSOCIATED_DOMAINS: "1",
		EXPO_PUBLIC_CAP_WEB_URL: apiBaseUrl,
	},
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
