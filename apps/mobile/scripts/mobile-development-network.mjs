import { networkInterfaces } from "node:os";

const preferredInterfaceNames = ["en0", "en1", "en2"];
const virtualInterfacePattern =
	/^(awdl|bridge|docker|llw|lo|tailscale|utun|vbox|vmnet)/i;

export const isPrivateIpv4 = ({ address, family, internal }) =>
	(family === "IPv4" || family === 4) &&
	!internal &&
	(address.startsWith("10.") ||
		address.startsWith("192.168.") ||
		/^172\.(1[6-9]|2\d|3[01])\./.test(address));

const privateAddressFor = (interfaces, name) =>
	interfaces[name]?.find(isPrivateIpv4)?.address;

export const findLanAddress = (interfaces = networkInterfaces()) => {
	for (const name of preferredInterfaceNames) {
		const address = privateAddressFor(interfaces, name);
		if (address) return address;
	}

	for (const [name, addresses] of Object.entries(interfaces)) {
		if (virtualInterfacePattern.test(name)) continue;
		const address = addresses?.find(isPrivateIpv4)?.address;
		if (address) return address;
	}
};

const validatedPort = (value) => {
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(`Invalid local API port: ${value}`);
	}
	return String(port);
};

export const resolvePhysicalApiBaseUrl = ({
	env = process.env,
	interfaces = networkInterfaces(),
} = {}) => {
	if (env.CAP_MOBILE_DEVICE_API_URL) {
		return env.CAP_MOBILE_DEVICE_API_URL;
	}

	const lanAddress = env.CAP_MOBILE_LAN_IP ?? findLanAddress(interfaces);
	if (lanAddress) {
		const port = validatedPort(env.CAP_MOBILE_LOCAL_API_PORT ?? "3000");
		return `http://${lanAddress}:${port}`;
	}

	if (env.EXPO_PUBLIC_CAP_WEB_URL) {
		return env.EXPO_PUBLIC_CAP_WEB_URL;
	}

	throw new Error(
		"Unable to find the Mac LAN address. Set CAP_MOBILE_DEVICE_API_URL explicitly.",
	);
};
