import { describe, expect, it } from "vitest";
import {
	findLanAddress,
	resolvePhysicalApiBaseUrl,
} from "./mobile-development-network.mjs";

const address = (value) => ({
	address: value,
	family: "IPv4",
	internal: false,
	netmask: "255.255.255.0",
	cidr: `${value}/24`,
	mac: "00:00:00:00:00:00",
});

describe("mobile physical-device networking", () => {
	it("prefers the Wi-Fi address over VPN interfaces", () => {
		expect(
			findLanAddress({
				utun4: [address("10.8.0.2")],
				en0: [address("192.168.4.108")],
			}),
		).toBe("192.168.4.108");
	});

	it("finds a private address on a nonstandard physical interface", () => {
		expect(
			findLanAddress({
				utun4: [address("10.8.0.2")],
				en7: [address("172.20.10.3")],
			}),
		).toBe("172.20.10.3");
	});

	it("does not mistake a VPN address for the local network", () => {
		expect(
			findLanAddress({
				utun4: [address("10.8.0.2")],
			}),
		).toBeUndefined();
	});

	it("builds the physical API URL from the current LAN address", () => {
		expect(
			resolvePhysicalApiBaseUrl({
				env: {
					CAP_MOBILE_LOCAL_API_PORT: "3001",
					EXPO_PUBLIC_CAP_WEB_URL: "http://localhost:3000",
				},
				interfaces: { en0: [address("192.168.1.12")] },
			}),
		).toBe("http://192.168.1.12:3001");
	});

	it("allows an explicit physical-device API override", () => {
		expect(
			resolvePhysicalApiBaseUrl({
				env: { CAP_MOBILE_DEVICE_API_URL: "https://dev.cap.example" },
				interfaces: {},
			}),
		).toBe("https://dev.cap.example");
	});
});
