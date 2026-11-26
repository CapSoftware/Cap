import { createPrivateKey, createSign } from "node:crypto";
import { type ClientHttp2Session, connect, constants } from "node:http2";
import { serverEnv } from "@cap/env";

export type PushEnvironment = "sandbox" | "production";

export interface PushTarget {
	token: string;
	environment: PushEnvironment;
}

export interface PushMessage {
	title: string;
	body: string;
	capId: string;
}

export type PushResult = "sent" | "invalid-token" | "failed";

export interface ApnsConfig {
	keyId: string;
	teamId: string;
	privateKey: string;
}

export const APNS_TOPIC = "so.cap.mobile";

const hosts: Record<PushEnvironment, string> = {
	production: "https://api.push.apple.com",
	sandbox: "https://api.sandbox.push.apple.com",
};

// Apple rejects provider tokens older than an hour and throttles ones refreshed more than every 20 minutes.
const PROVIDER_TOKEN_TTL_MS = 50 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5000;
const INVALID_TOKEN_REASONS = new Set([
	"BadDeviceToken",
	"Unregistered",
	"DeviceTokenNotForTopic",
]);

export const apnsConfig = (): ApnsConfig | null => {
	const env = serverEnv();
	if (!env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_PRIVATE_KEY) {
		return null;
	}
	return {
		keyId: env.APNS_KEY_ID,
		teamId: env.APNS_TEAM_ID,
		privateKey: env.APNS_PRIVATE_KEY.replace(/\\n/g, "\n"),
	};
};

const base64url = (value: string | Buffer) =>
	Buffer.from(value).toString("base64url");

let cachedProviderToken: {
	value: string;
	issuedAt: number;
	keyId: string;
} | null = null;

export const providerToken = (config: ApnsConfig, now = Date.now()) => {
	if (
		cachedProviderToken &&
		cachedProviderToken.keyId === config.keyId &&
		now - cachedProviderToken.issuedAt < PROVIDER_TOKEN_TTL_MS
	) {
		return cachedProviderToken.value;
	}
	const header = base64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
	const claims = base64url(
		JSON.stringify({ iss: config.teamId, iat: Math.floor(now / 1000) }),
	);
	const signer = createSign("SHA256");
	signer.update(`${header}.${claims}`);
	const signature = signer.sign({
		key: createPrivateKey(config.privateKey),
		dsaEncoding: "ieee-p1363",
	});
	const value = `${header}.${claims}.${base64url(signature)}`;
	cachedProviderToken = { value, issuedAt: now, keyId: config.keyId };
	return value;
};

export const resetProviderTokenCache = () => {
	cachedProviderToken = null;
};

export const apnsPayload = (message: PushMessage) =>
	JSON.stringify({
		aps: {
			alert: { title: message.title, body: message.body },
			sound: "default",
			"thread-id": message.capId,
		},
		capId: message.capId,
	});

const classify = (status: number, body: string): PushResult => {
	if (status === 200) return "sent";
	if (status === 410) return "invalid-token";
	if (status === 400) {
		try {
			const reason = (JSON.parse(body) as { reason?: string }).reason;
			if (reason && INVALID_TOKEN_REASONS.has(reason)) return "invalid-token";
		} catch {}
	}
	return "failed";
};

const sendOne = (
	session: ClientHttp2Session,
	authorization: string,
	token: string,
	payload: string,
) =>
	new Promise<PushResult>((resolve) => {
		let status = 0;
		let body = "";
		let settled = false;
		const finish = (result: PushResult) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		try {
			const request = session.request({
				":method": "POST",
				":path": `/3/device/${token}`,
				authorization: `bearer ${authorization}`,
				"apns-topic": APNS_TOPIC,
				"apns-push-type": "alert",
				"apns-priority": "10",
				"content-type": "application/json",
			});
			request.setTimeout(REQUEST_TIMEOUT_MS, () => {
				request.close(constants.NGHTTP2_CANCEL);
				finish("failed");
			});
			request.setEncoding("utf8");
			request.on("response", (headers) => {
				status = Number(headers[":status"] ?? 0);
			});
			request.on("data", (chunk: string) => {
				body += chunk;
			});
			request.on("end", () => {
				const result = classify(status, body);
				if (result === "failed") {
					console.error("APNs push failed", { status, body });
				}
				finish(result);
			});
			request.on("error", () => finish("failed"));
			request.end(payload);
		} catch {
			finish("failed");
		}
	});

/** Sends one message to each target. Never throws; each target gets its own result. */
export async function sendPushes(
	config: ApnsConfig,
	targets: PushTarget[],
	message: PushMessage,
	connectTo: typeof connect = connect,
): Promise<Map<string, PushResult>> {
	const results = new Map<string, PushResult>();
	if (targets.length === 0) return results;

	let authorization: string;
	try {
		authorization = providerToken(config);
	} catch (error) {
		console.error("APNs provider token could not be signed", error);
		for (const target of targets) results.set(target.token, "failed");
		return results;
	}
	const payload = apnsPayload(message);

	await Promise.all(
		(["production", "sandbox"] as const).map(async (environment) => {
			const group = targets.filter((t) => t.environment === environment);
			if (group.length === 0) return;
			let session: ClientHttp2Session | undefined;
			try {
				session = connectTo(hosts[environment]);
				session.on("error", () => {});
				const sent = await Promise.all(
					group.map((target) =>
						sendOne(
							session as ClientHttp2Session,
							authorization,
							target.token,
							payload,
						),
					),
				);
				group.forEach((target, index) => {
					results.set(target.token, sent[index] ?? "failed");
				});
			} catch {
				for (const target of group) results.set(target.token, "failed");
			} finally {
				session?.close();
			}
		}),
	);
	return results;
}
