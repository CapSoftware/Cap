import { lookup as dnsLookupCallback, type LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { db } from "@cap/database";
import { decrypt, encrypt } from "@cap/database/crypto";
import { nanoId } from "@cap/database/helpers";
import { s3Buckets } from "@cap/database/schema";
import { Organisation, S3Bucket } from "@cap/web-domain";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { withAuth } from "@/app/api/utils";
import {
	getAccessibleOrganization,
	getManagedOrganizationStorage,
	getOrganizationS3Bucket,
} from "./organizationStorage";

export const app = new Hono().use(withAuth);

const defaultS3Config = {
	provider: "aws",
	accessKeyId: "",
	secretAccessKey: "",
	endpoint: "https://s3.amazonaws.com",
	bucketName: "",
	region: "us-east-1",
};

const orgIdQuery = z.object({
	orgId: z
		.string()
		.optional()
		.transform((value) =>
			value ? Organisation.OrganisationId.make(value) : undefined,
		),
});

const decryptBucketConfig = async (
	bucket: typeof s3Buckets.$inferSelect,
	exposeSecrets: boolean,
) => ({
	provider: bucket.provider,
	accessKeyId: exposeSecrets ? await decrypt(bucket.accessKeyId) : "",
	secretAccessKey: exposeSecrets ? await decrypt(bucket.secretAccessKey) : "",
	endpoint: bucket.endpoint
		? await decrypt(bucket.endpoint)
		: "https://s3.amazonaws.com",
	bucketName: await decrypt(bucket.bucketName),
	region: await decrypt(bucket.region),
});

const getS3ErrorMetadata = (error: unknown) => {
	if (!error || typeof error !== "object" || !("$metadata" in error)) {
		return undefined;
	}

	return error.$metadata as { httpStatusCode?: number } | undefined;
};

// Expand an IPv6 string (already validated by `isIP() === 6`) into its 8
// numeric hextets, converting any trailing dotted-quad (IPv4-mapped/compatible
// form) into two hextets so both `::ffff:127.0.0.1` and `::ffff:7f00:1` resolve
// the same. Returns null if it can't be parsed.
const expandIpv6 = (
	ip: string,
): [number, number, number, number, number, number, number, number] | null => {
	let value = ip.toLowerCase().split("%")[0] ?? ""; // drop any zone id
	const dotted = value.match(/^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/);
	if (dotted) {
		const prefix = dotted[1];
		const quadStr = dotted[2];
		if (!prefix || !quadStr) return null;
		const quad = quadStr.split(".").map((o) => Number.parseInt(o, 10));
		if (
			quad.length !== 4 ||
			quad.some((o) => !Number.isInteger(o) || o < 0 || o > 255)
		)
			return null;
		const [q0, q1, q2, q3] = quad as [number, number, number, number];
		value = `${prefix}${((q0 << 8) | q1).toString(16)}:${((q2 << 8) | q3).toString(16)}`;
	}

	const halves = value.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	if (halves.length === 1 && head.length !== 8) return null;
	const fill = 8 - head.length - tail.length;
	if (fill < 0) return null;
	const groups = [...head, ...Array(fill).fill("0"), ...tail];
	if (groups.length !== 8) return null;
	const hextets = groups.map((g) => Number.parseInt(g || "0", 16));
	if (hextets.some((h) => Number.isNaN(h) || h < 0 || h > 0xffff)) return null;
	return hextets as [
		number,
		number,
		number,
		number,
		number,
		number,
		number,
		number,
	];
};

// SSRF protection for the user-supplied `endpoint` in /test: Cap's server can
// never legitimately reach a user's private-LAN S3 endpoint, so we reject any
// endpoint whose host is/resolves to loopback, private, link-local or reserved
// ranges (incl. the cloud metadata IP) before constructing the S3 client.
const isBlockedIp = (ip: string): boolean => {
	const version = isIP(ip);

	if (version === 4) {
		const octets = ip.split(".").map((part) => Number.parseInt(part, 10));
		if (octets.length !== 4 || octets.some((o) => Number.isNaN(o))) return true;
		const a = octets[0] ?? -1;
		const b = octets[1] ?? -1;
		if (a === 0) return true; // 0.0.0.0/8 (incl. 0.0.0.0)
		if (a === 127) return true; // 127.0.0.0/8 loopback
		if (a === 10) return true; // 10.0.0.0/8 private
		if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
		if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
		if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. metadata)
		if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
		if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
		return false;
	}

	if (version === 6) {
		const h = expandIpv6(ip);
		if (!h) return true; // unparseable IPv6 → fail safe

		// ::ffff:a.b.c.d — IPv4-mapped, in dotted OR pure-hex form (e.g.
		// ::ffff:7f00:1 == 127.0.0.1). Evaluate the embedded IPv4 directly.
		if (
			h[0] === 0 &&
			h[1] === 0 &&
			h[2] === 0 &&
			h[3] === 0 &&
			h[4] === 0 &&
			h[5] === 0xffff
		) {
			const a = (h[6] >> 8) & 0xff;
			const b = h[6] & 0xff;
			const c = (h[7] >> 8) & 0xff;
			const d = h[7] & 0xff;
			return isBlockedIp(`${a}.${b}.${c}.${d}`);
		}

		// ::1 loopback / :: unspecified.
		if (h.slice(0, 7).every((part) => part === 0) && h[7] <= 1) return true;
		// fe80::/10 link-local (fe80–febf).
		if ((h[0] & 0xffc0) === 0xfe80) return true;
		// fc00::/7 unique-local (fc00–fdff).
		if ((h[0] & 0xfe00) === 0xfc00) return true;
		return false;
	}

	return true;
};

const isBlockedHostname = (hostname: string): boolean => {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	if (!host) return true;
	if (host === "localhost" || host.endsWith(".localhost")) return true;
	if (host.endsWith(".internal")) return true;
	return false;
};

const isBlockedEndpoint = async (endpoint: string): Promise<boolean> => {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return true;
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") return true;

	// Reject credentials embedded in the URL (http://user:pass@host) to avoid
	// surprising behaviour and accidental secret leakage.
	if (url.username || url.password) return true;

	const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
	if (!hostname) return true;

	if (isBlockedHostname(hostname)) return true;

	// WHATWG URL keeps the surrounding brackets on IPv6 literals
	// (new URL("http://[::1]/").hostname === "[::1]"), so strip them before the
	// IP check — otherwise isIP() returns 0 and the literal IPv6 SSRF target
	// (e.g. [::1], [fc00::1], [::ffff:127.0.0.1]) would fall through to DNS.
	const ipCandidate = hostname.replace(/^\[/, "").replace(/\]$/, "");

	// Literal IP address: validate directly.
	if (isIP(ipCandidate) !== 0) return isBlockedIp(ipCandidate);

	// Hostname: resolve all addresses and block if any is private/reserved.
	try {
		const addresses = await lookup(hostname, { all: true });
		if (addresses.length === 0) return true;
		return addresses.some((addr) => isBlockedIp(addr.address));
	} catch {
		// Unresolvable host: let the S3 client surface the normal connection error.
		return false;
	}
};

// A DNS lookup that refuses to resolve to a blocked (private/reserved) address.
// Used by the S3 client's HTTP agents so the address the socket actually
// connects to is re-validated at connection time — closing the DNS-rebinding /
// TOCTOU window between `isBlockedEndpoint` and the SDK's own DNS resolution.
type LookupCallback = (
	err: NodeJS.ErrnoException | null,
	address: string | LookupAddress[],
	family?: number,
) => void;

function guardedLookup(
	hostname: string,
	options: unknown,
	callback: LookupCallback,
): void {
	// `dns.lookup` is heavily overloaded; cast to a single concrete signature so
	// we can forward the agent-provided options and a union-typed callback.
	const lookupFn = dnsLookupCallback as unknown as (
		hostname: string,
		options: object,
		callback: LookupCallback,
	) => void;
	lookupFn(hostname, (options ?? {}) as object, (err, address, family) => {
		if (err) return callback(err, address, family);
		const candidates: LookupAddress[] = Array.isArray(address)
			? address
			: [{ address, family: family ?? 0 }];
		const blocked = candidates.find((entry) => isBlockedIp(entry.address));
		if (blocked) {
			const blockErr: NodeJS.ErrnoException = new Error(
				`Refused to connect to blocked address ${blocked.address}`,
			);
			blockErr.code = "EAI_BLOCKED";
			return callback(blockErr, address, family);
		}
		callback(err, address, family);
	});
}

app.post(
	"/",
	zValidator(
		"json",
		z.object({
			provider: z.string(),
			accessKeyId: z.string(),
			secretAccessKey: z.string(),
			endpoint: z.string(),
			bucketName: z.string(),
			region: z.string(),
		}),
	),
	async (c) => {
		const user = c.get("user");
		const data = c.req.valid("json");

		try {
			const encryptedConfig = {
				id: S3Bucket.S3BucketId.make(nanoId()),
				provider: data.provider,
				accessKeyId: await encrypt(data.accessKeyId),
				secretAccessKey: await encrypt(data.secretAccessKey),
				endpoint: data.endpoint ? await encrypt(data.endpoint) : null,
				bucketName: await encrypt(data.bucketName),
				region: await encrypt(data.region),
				ownerId: user.id,
				organizationId: null,
				active: true,
			};

			await db().transaction(async (tx) => {
				await tx
					.update(s3Buckets)
					.set({ active: false })
					.where(
						and(
							eq(s3Buckets.ownerId, user.id),
							isNull(s3Buckets.organizationId),
						),
					);
				await tx.insert(s3Buckets).values(encryptedConfig);
			});

			return c.json({ success: true });
		} catch (error) {
			console.error("Error in S3 config route:", error);
			return c.json(
				{
					error: "Failed to save S3 configuration",
					details: error instanceof Error ? error.message : String(error),
				},
				{ status: 500 },
			);
		}
	},
);

app.delete("/delete", async (c) => {
	const user = c.get("user");

	try {
		await db()
			.update(s3Buckets)
			.set({ active: false })
			.where(
				and(eq(s3Buckets.ownerId, user.id), isNull(s3Buckets.organizationId)),
			);

		return c.json({ success: true });
	} catch (error) {
		console.error("Error in S3 config delete route:", error);
		return c.json(
			{
				error: "Failed to delete S3 configuration",
				details: error instanceof Error ? error.message : String(error),
			},
			{ status: 500 },
		);
	}
});

app.get("/get", zValidator("query", orgIdQuery), async (c) => {
	const user = c.get("user");
	const { orgId } = c.req.valid("query");

	try {
		if (orgId) {
			const organization = await getAccessibleOrganization(user.id, orgId);
			if (!organization)
				return c.json({ error: "forbidden_org" }, { status: 403 });

			const managedByOrganization = await getManagedOrganizationStorage(
				user.id,
				orgId,
			);
			if (managedByOrganization?.activeProvider === "s3") {
				const bucket = await getOrganizationS3Bucket(orgId);
				if (bucket) {
					return c.json({
						config: await decryptBucketConfig(bucket, false),
						source: "organization" as const,
						managedByOrganization,
					});
				}
			}

			if (managedByOrganization) {
				return c.json({
					config: defaultS3Config,
					source: "organization" as const,
					managedByOrganization,
				});
			}
		}

		const [bucket] = await db()
			.select()
			.from(s3Buckets)
			.where(
				and(
					eq(s3Buckets.ownerId, user.id),
					isNull(s3Buckets.organizationId),
					eq(s3Buckets.active, true),
				),
			)
			.orderBy(desc(s3Buckets.updatedAt))
			.limit(1);

		if (!bucket)
			return c.json({
				config: defaultS3Config,
				source: "default" as const,
				managedByOrganization: null,
			});

		return c.json({
			config: await decryptBucketConfig(bucket, true),
			source: "user" as const,
			managedByOrganization: null,
		});
	} catch (error) {
		console.error("Error in S3 config get route:", error);
		return c.json(
			{
				error: "Failed to fetch S3 configuration",
				details: error instanceof Error ? error.message : String(error),
			},
			{ status: 500 },
		);
	}
});

app.post(
	"/test",
	zValidator(
		"json",
		z.object({
			provider: z.string(),
			accessKeyId: z.string(),
			secretAccessKey: z.string(),
			endpoint: z.string(),
			bucketName: z.string(),
			region: z.string(),
		}),
	),
	async (c) => {
		const TIMEOUT_MS = 5000; // 5 second timeout
		const data = c.req.valid("json");

		try {
			if (await isBlockedEndpoint(data.endpoint)) {
				return c.json(
					{
						error:
							"Invalid endpoint. Please provide a valid public S3-compatible endpoint URL.",
						details: "The provided endpoint is not allowed.",
						metadata: undefined,
					},
					{ status: 400 },
				);
			}

			const s3Client = new S3Client({
				endpoint: data.endpoint,
				region: data.region,
				credentials: {
					accessKeyId: data.accessKeyId,
					secretAccessKey: data.secretAccessKey,
				},
				// Re-validate the resolved IP at connection time (not just in the
				// pre-flight isBlockedEndpoint check) so a low-TTL DNS rebind can't
				// point the socket at a private/metadata address after the check.
				requestHandler: {
					httpAgent: new HttpAgent({
						lookup: guardedLookup as unknown as LookupFunction,
					}),
					httpsAgent: new HttpsAgent({
						lookup: guardedLookup as unknown as LookupFunction,
					}),
					connectionTimeout: TIMEOUT_MS,
					requestTimeout: TIMEOUT_MS,
				},
			});

			try {
				await s3Client.send(new HeadBucketCommand({ Bucket: data.bucketName }));
			} catch (error) {
				console.log(error);
				let errorMessage = "Failed to connect to S3";

				if (error instanceof Error) {
					if (error.name === "AbortError" || error.name === "TimeoutError") {
						errorMessage =
							"Connection timed out after 5 seconds. Please check the endpoint URL and your network connection.";
					} else if (error.name === "NoSuchBucket") {
						errorMessage = `Bucket '${data.bucketName}' does not exist`;
					} else if (error.name === "NetworkingError") {
						errorMessage =
							"Network error. Please check the endpoint URL and your network connection.";
					} else if (error.name === "InvalidAccessKeyId") {
						errorMessage = "Invalid Access Key ID";
					} else if (error.name === "SignatureDoesNotMatch") {
						errorMessage = "Invalid Secret Access Key";
					} else if (error.name === "AccessDenied") {
						errorMessage =
							"Access denied. Please check your credentials and bucket permissions.";
					} else if (getS3ErrorMetadata(error)?.httpStatusCode === 301) {
						errorMessage =
							"Received 301 redirect. This usually means the endpoint URL is incorrect or the bucket is in a different region.";
					}
				}

				return c.json(
					{
						error: errorMessage,
						details: error instanceof Error ? error.message : String(error),
						metadata: getS3ErrorMetadata(error),
					},
					{ status: 500 },
				);
			}

			return c.json({ success: true });
		} catch (error) {
			return c.json(
				{
					error: "Failed to connect to S3",
					details: error instanceof Error ? error.message : String(error),
					metadata: getS3ErrorMetadata(error),
				},
				{ status: 500 },
			);
		}
	},
);
