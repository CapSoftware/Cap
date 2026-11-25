import { IP_REPUTATION_LISTS } from "@/lib/ip-reputation";

export const DATACENTER_ADDRESS = "198.51.100.7";
export const DATACENTER_IPV6_ADDRESS = "2001:db8:ff12::1";
export const VPN_ADDRESS = "192.0.2.130";
export const UNLISTED_ADDRESS = "203.0.113.20";

const filler = (make: (index: number) => string) =>
	Array.from({ length: 60 }, (_, index) => make(index));

export const listBodies: Record<string, string> = {
	[IP_REPUTATION_LISTS.datacenter.ipv4]: [
		"# datacenter",
		...filler((index) => `10.${index}.0.0/16`),
		"198.51.100.0/24",
	].join("\n"),
	[IP_REPUTATION_LISTS.datacenter.ipv6]: [
		...filler((index) => `2001:db8:${index.toString(16)}::/48`),
		"2001:db8:ff00::/40",
	].join("\n"),
	[IP_REPUTATION_LISTS.vpn.ipv4]: [
		...filler((index) => `172.16.${index}.0/24`),
		"192.0.2.128/25",
	].join("\n"),
	[IP_REPUTATION_LISTS.vpn.ipv6]: filler(
		(index) => `fd00:${index.toString(16)}::/32`,
	).join("\n"),
};

export async function listFetch(input: RequestInfo | URL): Promise<Response> {
	const body = listBodies[String(input)];
	return body === undefined
		? new Response("not found", { status: 404 })
		: new Response(body);
}
