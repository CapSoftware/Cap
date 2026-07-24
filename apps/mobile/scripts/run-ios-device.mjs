import { spawnSync } from "node:child_process";
import {
	findLanAddress,
	resolvePhysicalApiBaseUrl,
} from "./mobile-development-network.mjs";

const lanAddress = process.env.CAP_MOBILE_LAN_IP ?? findLanAddress();
const apiBaseUrl = resolvePhysicalApiBaseUrl();

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
		...(lanAddress && !process.env.REACT_NATIVE_PACKAGER_HOSTNAME
			? { REACT_NATIVE_PACKAGER_HOSTNAME: lanAddress }
			: {}),
	},
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
