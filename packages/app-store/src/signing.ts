import {
	createHash,
	createPrivateKey,
	createPublicKey,
	hkdfSync,
	type KeyObject,
	sign,
	verify,
} from "node:crypto";
import {
	REQUEST_ID_HEADER,
	REQUEST_KIND_HEADER,
	SIGNATURE_HEADER,
	SIGNATURE_TOLERANCE_SECONDS,
	TIMESTAMP_HEADER,
} from "./constants";

export type CapRequestKind = "lifecycle" | "event" | "action";

export type CapPublicKey = {
	kty: "OKP";
	crv: "Ed25519";
	x: string;
	kid: string;
	use: "sig";
	alg: "EdDSA";
};

export type CapPublicKeySet = { keys: CapPublicKey[] };

const PKCS8_ED25519_PREFIX = Buffer.from(
	"302e020100300506032b657004220420",
	"hex",
);
const SIGNING_INFO = "cap-app-store-request-signing-v1";
const SIGNING_SALT = "cap-app-store";

export type CapSigningKey = {
	privateKey: KeyObject;
	publicKey: CapPublicKey;
};

export function deriveSigningKey(serverSecret: string): CapSigningKey {
	if (serverSecret.length < 16) {
		throw new Error("The server secret is too short to derive a signing key");
	}
	const seed = Buffer.from(
		hkdfSync("sha256", serverSecret, SIGNING_SALT, SIGNING_INFO, 32),
	);
	const privateKey = createPrivateKey({
		key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
		format: "der",
		type: "pkcs8",
	});
	const jwk = createPublicKey(privateKey).export({ format: "jwk" });
	if (typeof jwk.x !== "string") throw new Error("Could not export public key");
	const kid = createHash("sha256")
		.update(Buffer.from(jwk.x, "base64url"))
		.digest("hex")
		.slice(0, 16);
	return {
		privateKey,
		publicKey: {
			kty: "OKP",
			crv: "Ed25519",
			x: jwk.x,
			kid,
			use: "sig",
			alg: "EdDSA",
		},
	};
}

const signedMessage = (timestamp: string, requestId: string, body: string) =>
	Buffer.from(`v1.${timestamp}.${requestId}.${body}`, "utf8");

export function signCapRequest(input: {
	key: CapSigningKey;
	body: string;
	requestId: string;
	kind: CapRequestKind;
	now?: number;
}): Record<string, string> {
	const timestamp = String(Math.floor((input.now ?? Date.now()) / 1000));
	const signature = sign(
		null,
		signedMessage(timestamp, input.requestId, input.body),
		input.key.privateKey,
	).toString("base64url");
	return {
		[SIGNATURE_HEADER]: `kid=${input.key.publicKey.kid},v1=${signature}`,
		[TIMESTAMP_HEADER]: timestamp,
		[REQUEST_ID_HEADER]: input.requestId,
		[REQUEST_KIND_HEADER]: input.kind,
	};
}

export type VerifyFailure =
	| "missing_headers"
	| "bad_signature_header"
	| "unknown_key"
	| "stale_timestamp"
	| "bad_signature";

const headerValue = (
	headers: Headers | Record<string, string | undefined>,
	name: string,
) =>
	headers instanceof Headers
		? (headers.get(name) ?? undefined)
		: (headers[name] ?? headers[name.toLowerCase()]);

export function verifyCapRequest(input: {
	headers: Headers | Record<string, string | undefined>;
	body: string;
	keys: CapPublicKeySet;
	now?: number;
	toleranceSeconds?: number;
}):
	| { ok: true; requestId: string; kind: string }
	| { ok: false; reason: VerifyFailure } {
	const signatureHeader = headerValue(input.headers, SIGNATURE_HEADER);
	const timestamp = headerValue(input.headers, TIMESTAMP_HEADER);
	const requestId = headerValue(input.headers, REQUEST_ID_HEADER);
	const kind = headerValue(input.headers, REQUEST_KIND_HEADER);
	if (!signatureHeader || !timestamp || !requestId || !kind) {
		return { ok: false, reason: "missing_headers" };
	}
	const parts = new Map(
		signatureHeader.split(",").map((part) => {
			const index = part.indexOf("=");
			return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
		}),
	);
	const kid = parts.get("kid");
	const signature = parts.get("v1");
	if (!kid || !signature || !/^\d+$/.test(timestamp)) {
		return { ok: false, reason: "bad_signature_header" };
	}
	const key = input.keys.keys.find((candidate) => candidate.kid === kid);
	if (!key) return { ok: false, reason: "unknown_key" };
	const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000);
	const tolerance = input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
	if (Math.abs(nowSeconds - Number(timestamp)) > tolerance) {
		return { ok: false, reason: "stale_timestamp" };
	}
	let valid = false;
	try {
		valid = verify(
			null,
			signedMessage(timestamp, requestId, input.body),
			createPublicKey({ key: { ...key }, format: "jwk" }),
			Buffer.from(signature, "base64url"),
		);
	} catch {
		valid = false;
	}
	return valid
		? { ok: true, requestId, kind }
		: { ok: false, reason: "bad_signature" };
}
