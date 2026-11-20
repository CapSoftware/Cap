import crypto from "node:crypto";
import { serverEnv } from "@cap/env";
import type { User } from "@cap/web-domain";
import {
	type AuthenticationResponseJSON,
	type AuthenticatorTransportFuture,
	generateAuthenticationOptions,
	generateRegistrationOptions,
	type PublicKeyCredentialCreationOptionsJSON,
	type PublicKeyCredentialRequestOptionsJSON,
	type RegistrationResponseJSON,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
} from "@simplewebauthn/server";
import {
	decodeAttestationObject,
	decodeClientDataJSON,
	isoBase64URL,
	isoCBOR,
	isoUint8Array,
} from "@simplewebauthn/server/helpers";
import { and, asc, count, eq } from "drizzle-orm";
import { nanoId } from "../helpers.ts";
import { db } from "../index.ts";
import { userPasskeys, users } from "../schema.ts";
import {
	consumeChallenge,
	spendPasskeySetup,
	storeChallenge,
} from "./auth-challenges.ts";

export const MAX_PASSKEYS_PER_USER = 10;
const MAX_RESPONSE_JSON_LENGTH = 16 * 1024;
const MAX_CREDENTIAL_ID_LENGTH = 1400;
const MAX_FIELD_LENGTH = 8 * 1024;
const CEREMONY_TIMEOUT_MS = 5 * 60 * 1000;

const KNOWN_PASSKEY_PROVIDERS: Record<string, string> = {
	"fbfc3007-154e-4ecc-8c0b-6e020557d7bd": "iCloud Keychain",
	"ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4": "Google Password Manager",
	"adce0002-35bc-c60a-648b-0b25f1f05503": "Chrome on Mac",
	"08987058-cadc-4b81-b6e1-30de50dcbe96": "Windows Hello",
	"9ddd1817-af5a-4672-a2b9-3e3dd95000a9": "Windows Hello",
	"6028b017-b1d4-4c02-b4b3-afcdafc96bb2": "Windows Hello",
	"bada5566-a7aa-401f-bd96-45619a55120d": "1Password",
	"d548826e-79b4-db40-a3d8-11116f7e8349": "Bitwarden",
	"531126d6-e717-415c-9320-3d9aa6981239": "Dashlane",
	"53414d53-554e-4700-0000-000000000000": "Samsung Pass",
};

const TRANSPORTS = new Set<AuthenticatorTransportFuture>([
	"ble",
	"cable",
	"hybrid",
	"internal",
	"nfc",
	"smart-card",
	"usb",
]);

export type PasskeySummary = {
	id: string;
	name: string;
	createdAt: Date;
	lastUsedAt: Date | null;
	backedUp: boolean;
	confirmsIdentity: boolean;
};

export function passkeyRelyingParty() {
	const url = new URL(serverEnv().WEB_URL);
	return { rpID: url.hostname, origin: url.origin, rpName: "Cap" };
}

function hashCredentialId(credentialId: string) {
	return crypto.createHash("sha256").update(credentialId).digest("hex");
}

function webAuthnUserId(userId: string) {
	return isoUint8Array.fromUTF8String(userId);
}

function isBase64Url(value: unknown, maxLength = MAX_FIELD_LENGTH) {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= maxLength &&
		/^[A-Za-z0-9_-]+$/.test(value)
	);
}

function parseResponseJson(raw: unknown): Record<string, unknown> | null {
	if (typeof raw !== "string" || raw.length > MAX_RESPONSE_JSON_LENGTH) {
		return null;
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (
		!isBase64Url(record.id, MAX_CREDENTIAL_ID_LENGTH) ||
		record.rawId !== record.id ||
		record.type !== "public-key" ||
		!record.response ||
		typeof record.response !== "object"
	) {
		return null;
	}
	return record;
}

export function parseAuthenticationResponse(
	raw: unknown,
): AuthenticationResponseJSON | null {
	const record = parseResponseJson(raw);
	if (!record) return null;
	const response = record.response as Record<string, unknown>;
	if (
		!isBase64Url(response.clientDataJSON) ||
		!isBase64Url(response.authenticatorData) ||
		!isBase64Url(response.signature) ||
		(response.userHandle !== undefined &&
			response.userHandle !== null &&
			!isBase64Url(response.userHandle, 128))
	) {
		return null;
	}
	return {
		id: record.id as string,
		rawId: record.rawId as string,
		type: "public-key",
		response: {
			clientDataJSON: response.clientDataJSON as string,
			authenticatorData: response.authenticatorData as string,
			signature: response.signature as string,
			...(typeof response.userHandle === "string"
				? { userHandle: response.userHandle }
				: {}),
		},
		clientExtensionResults: {},
	};
}

export function parseRegistrationResponse(
	raw: unknown,
): RegistrationResponseJSON | null {
	const record = parseResponseJson(raw);
	if (!record) return null;
	const response = record.response as Record<string, unknown>;
	if (
		!isBase64Url(response.clientDataJSON) ||
		!isBase64Url(response.attestationObject, 64 * 1024)
	) {
		return null;
	}
	const transports = Array.isArray(response.transports)
		? response.transports.filter(
				(transport): transport is AuthenticatorTransportFuture =>
					typeof transport === "string" &&
					TRANSPORTS.has(transport as AuthenticatorTransportFuture),
			)
		: [];
	const attestationObject = withoutAttestation(
		response.attestationObject as string,
	);
	if (!attestationObject) return null;
	return {
		id: record.id as string,
		rawId: record.rawId as string,
		type: "public-key",
		response: {
			clientDataJSON: response.clientDataJSON as string,
			attestationObject,
			transports,
		},
		clientExtensionResults: {},
	};
}

/**
 * Cap requests no attestation and never trusts it, so the statement is
 * dropped before verification. Verifying other formats would make the library
 * download revocation lists from URLs inside client-supplied certificates.
 */
function withoutAttestation(attestationObject: string) {
	try {
		const authData = decodeAttestationObject(
			isoBase64URL.toBuffer(attestationObject),
		).get("authData");
		if (!(authData instanceof Uint8Array)) return null;
		return isoBase64URL.fromBuffer(
			isoCBOR.encode(
				new Map<string, string | Uint8Array | Map<string, never>>([
					["fmt", "none"],
					["attStmt", new Map<string, never>()],
					["authData", authData],
				]),
			),
		);
	} catch {
		return null;
	}
}

function readChallenge(clientDataJSON: string, expectedType: string) {
	try {
		const clientData = decodeClientDataJSON(clientDataJSON);
		if (
			clientData.type !== expectedType ||
			typeof clientData.challenge !== "string" ||
			clientData.crossOrigin === true ||
			(clientData as { topOrigin?: unknown }).topOrigin !== undefined
		) {
			return null;
		}
		return clientData.challenge;
	} catch {
		return null;
	}
}

function storedTransports(value: unknown) {
	if (!Array.isArray(value)) return undefined;
	return value.filter(
		(transport): transport is AuthenticatorTransportFuture =>
			typeof transport === "string" &&
			TRANSPORTS.has(transport as AuthenticatorTransportFuture),
	);
}

export async function createPasskeySignInOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
	const { rpID } = passkeyRelyingParty();
	const options = await generateAuthenticationOptions({
		rpID,
		userVerification: "required",
		timeout: CEREMONY_TIMEOUT_MS,
	});
	await storeChallenge({
		purpose: "passkey_sign_in",
		challenge: options.challenge,
		userId: null,
	});
	return options;
}

export async function createPasskeyStepUpOptions(
	userId: User.UserId,
): Promise<PublicKeyCredentialRequestOptionsJSON | null> {
	const passkeys = await db()
		.select({
			credentialId: userPasskeys.credentialId,
			transports: userPasskeys.transports,
		})
		.from(userPasskeys)
		.where(
			and(
				eq(userPasskeys.userId, userId),
				eq(userPasskeys.confirmsIdentity, true),
			),
		);
	if (passkeys.length === 0) return null;
	const { rpID } = passkeyRelyingParty();
	const options = await generateAuthenticationOptions({
		rpID,
		userVerification: "required",
		timeout: CEREMONY_TIMEOUT_MS,
		allowCredentials: passkeys.map((passkey) => ({
			id: passkey.credentialId,
			transports: storedTransports(passkey.transports),
		})),
	});
	await storeChallenge({
		purpose: "passkey_step_up",
		challenge: options.challenge,
		userId,
	});
	return options;
}

/**
 * Verifies a passkey assertion. The challenge is claimed before anything else
 * is checked, so every challenge is good for exactly one attempt, and the
 * passkey row stays locked from the counter check to the counter write so
 * concurrent sign-ins cannot both pass against the same stored counter.
 */
async function verifyPasskeyAssertion(
	raw: unknown,
	purpose: "passkey_sign_in" | "passkey_step_up",
	userId: User.UserId | null,
) {
	const response = parseAuthenticationResponse(raw);
	if (!response) return null;
	const challenge = readChallenge(
		response.response.clientDataJSON,
		"webauthn.get",
	);
	if (!challenge) return null;
	if (!(await consumeChallenge({ purpose, challenge, userId }))) return null;

	const { rpID, origin } = passkeyRelyingParty();
	return db().transaction(async (tx) => {
		const [passkey] = await tx
			.select()
			.from(userPasskeys)
			.where(eq(userPasskeys.credentialIdHash, hashCredentialId(response.id)))
			.limit(1)
			.for("update");
		if (!passkey || passkey.credentialId !== response.id) return null;
		if (userId && passkey.userId !== userId) return null;
		if (purpose === "passkey_step_up" && !passkey.confirmsIdentity) return null;

		const [user] = await tx
			.select()
			.from(users)
			.where(eq(users.id, passkey.userId))
			.limit(1);
		if (!user) return null;

		const expectedUserHandle = isoBase64URL.fromBuffer(webAuthnUserId(user.id));
		if (
			(purpose === "passkey_sign_in" && !response.response.userHandle) ||
			(response.response.userHandle &&
				response.response.userHandle !== expectedUserHandle)
		) {
			return null;
		}

		let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
		try {
			verification = await verifyAuthenticationResponse({
				response,
				expectedChallenge: challenge,
				expectedOrigin: origin,
				expectedRPID: rpID,
				expectedType: "webauthn.get",
				requireUserVerification: true,
				credential: {
					id: passkey.credentialId,
					publicKey: isoBase64URL.toBuffer(passkey.publicKey),
					counter: passkey.counter,
					transports: storedTransports(passkey.transports),
				},
			});
		} catch {
			return null;
		}
		if (
			!verification.verified ||
			!verification.authenticationInfo.userVerified ||
			verification.authenticationInfo.credentialID !== passkey.credentialId
		) {
			return null;
		}

		await tx
			.update(userPasskeys)
			.set({
				counter: verification.authenticationInfo.newCounter,
				backedUp: verification.authenticationInfo.credentialBackedUp,
				lastUsedAt: new Date(),
			})
			.where(eq(userPasskeys.id, passkey.id));

		return user;
	});
}

export function verifyPasskeySignIn(raw: unknown) {
	return verifyPasskeyAssertion(raw, "passkey_sign_in", null);
}

export async function verifyPasskeyStepUp(userId: User.UserId, raw: unknown) {
	const user = await verifyPasskeyAssertion(raw, "passkey_step_up", userId);
	return user?.id === userId;
}

export async function countPasskeys(userId: User.UserId) {
	const [row] = await db()
		.select({ total: count() })
		.from(userPasskeys)
		.where(eq(userPasskeys.userId, userId));
	return row?.total ?? 0;
}

export async function createPasskeyRegistrationOptions(
	user: {
		id: User.UserId;
		email: string;
		name: string | null;
		lastName: string | null;
	},
	options: { firstPasskeyOnly?: boolean } = {},
): Promise<PublicKeyCredentialCreationOptionsJSON | null> {
	const existing = await db()
		.select({
			credentialId: userPasskeys.credentialId,
			transports: userPasskeys.transports,
		})
		.from(userPasskeys)
		.where(eq(userPasskeys.userId, user.id));
	if (existing.length >= MAX_PASSKEYS_PER_USER) return null;
	const { firstPasskeyOnly = false } = options;
	if (firstPasskeyOnly && existing.length > 0) return null;

	const { rpID, rpName } = passkeyRelyingParty();
	const displayName =
		[user.name, user.lastName].filter(Boolean).join(" ").trim() || user.email;
	const registration = await generateRegistrationOptions({
		rpName,
		rpID,
		userID: webAuthnUserId(user.id),
		userName: user.email,
		userDisplayName: displayName,
		attestationType: "none",
		timeout: CEREMONY_TIMEOUT_MS,
		excludeCredentials: existing.map((passkey) => ({
			id: passkey.credentialId,
			transports: storedTransports(passkey.transports),
		})),
		authenticatorSelection: {
			residentKey: "required",
			userVerification: "required",
		},
		supportedAlgorithmIDs: [-8, -7, -257],
	});
	await storeChallenge({
		purpose: firstPasskeyOnly
			? "passkey_first_registration"
			: "passkey_registration",
		challenge: registration.challenge,
		userId: user.id,
	});
	return registration;
}

export type PasskeyRegistrationResult =
	| { status: "registered"; passkey: PasskeySummary }
	| { status: "invalid" }
	| { status: "duplicate" }
	| { status: "limit" };

/**
 * `allowFirstPasskey` lets a challenge from the no-code route (a fresh
 * sign-in) be claimed. Passkeys added that way can sign in but never confirm
 * identity, so a briefly stolen session cannot escalate into an account
 * change.
 */
export async function verifyPasskeyRegistration(
	userId: User.UserId,
	raw: unknown,
	options: { allowFirstPasskey?: boolean } = {},
): Promise<PasskeyRegistrationResult> {
	const response = parseRegistrationResponse(raw);
	if (!response) return { status: "invalid" };
	const challenge = readChallenge(
		response.response.clientDataJSON,
		"webauthn.create",
	);
	if (!challenge) return { status: "invalid" };
	const [account] = await db()
		.select({ authSessionVersion: users.authSessionVersion })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (!account) return { status: "invalid" };

	const { rpID, origin } = passkeyRelyingParty();
	let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
	try {
		verification = await verifyRegistrationResponse({
			response,
			expectedChallenge: challenge,
			expectedOrigin: origin,
			expectedRPID: rpID,
			expectedType: "webauthn.create",
			requireUserVerification: true,
			supportedAlgorithmIDs: [-8, -7, -257],
		});
	} catch {
		return { status: "invalid" };
	}
	if (!verification.verified || !verification.registrationInfo.userVerified) {
		return { status: "invalid" };
	}

	const info = verification.registrationInfo;
	if (info.credential.id !== response.id) return { status: "invalid" };
	const credentialIdHash = hashCredentialId(info.credential.id);
	const id = nanoId();
	const createdAt = new Date();
	const name = KNOWN_PASSKEY_PROVIDERS[info.aaguid] ?? "Passkey";

	let confirmsIdentity = false;
	try {
		const inserted = await db().transaction(async (tx) => {
			const [locked] = await tx
				.select({ authSessionVersion: users.authSessionVersion })
				.from(users)
				.where(eq(users.id, userId))
				.for("update");
			if (locked?.authSessionVersion !== account.authSessionVersion) {
				return "reset";
			}
			const claimedSetup = await consumeChallenge({
				purpose: "passkey_registration",
				challenge,
				userId,
				database: tx,
			});
			const claimedFirst =
				!claimedSetup &&
				options.allowFirstPasskey === true &&
				(await consumeChallenge({
					purpose: "passkey_first_registration",
					challenge,
					userId,
					database: tx,
				}));
			if (!claimedSetup && !claimedFirst) return "reset";
			confirmsIdentity = claimedSetup;
			const [row] = await tx
				.select({ total: count() })
				.from(userPasskeys)
				.where(eq(userPasskeys.userId, userId));
			const existing = row?.total ?? 0;
			if (claimedFirst && existing > 0) return "reset";
			if (existing >= MAX_PASSKEYS_PER_USER) return "limit";
			await tx.insert(userPasskeys).values({
				id,
				userId,
				credentialId: info.credential.id,
				credentialIdHash,
				publicKey: isoBase64URL.fromBuffer(info.credential.publicKey),
				counter: info.credential.counter,
				transports: storedTransports(response.response.transports) ?? [],
				deviceType: info.credentialDeviceType,
				backedUp: info.credentialBackedUp,
				confirmsIdentity,
				aaguid: info.aaguid,
				name,
				createdAt,
			});
			await spendPasskeySetup(userId, tx);
			return "inserted";
		});
		if (inserted === "limit") return { status: "limit" };
		if (inserted === "reset") return { status: "invalid" };
	} catch (error) {
		if (isDuplicateKeyError(error)) return { status: "duplicate" };
		throw error;
	}

	return {
		status: "registered",
		passkey: {
			id,
			name,
			createdAt,
			lastUsedAt: null,
			backedUp: info.credentialBackedUp,
			confirmsIdentity,
		},
	};
}

function isDuplicateKeyError(error: unknown) {
	let current: unknown = error;
	for (let depth = 0; current && depth < 4; depth++) {
		if (
			typeof current === "object" &&
			(current as { code?: unknown }).code === "ER_DUP_ENTRY"
		) {
			return true;
		}
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

export async function listPasskeys(
	userId: User.UserId,
): Promise<PasskeySummary[]> {
	return db()
		.select({
			id: userPasskeys.id,
			name: userPasskeys.name,
			createdAt: userPasskeys.createdAt,
			lastUsedAt: userPasskeys.lastUsedAt,
			backedUp: userPasskeys.backedUp,
			confirmsIdentity: userPasskeys.confirmsIdentity,
		})
		.from(userPasskeys)
		.where(eq(userPasskeys.userId, userId))
		.orderBy(asc(userPasskeys.createdAt), asc(userPasskeys.id));
}

export async function deletePasskey(
	userId: User.UserId,
	passkeyId: string,
): Promise<{ name: string } | null> {
	if (typeof passkeyId !== "string" || passkeyId.length > 15) return null;
	return db().transaction(async (tx) => {
		const [passkey] = await tx
			.select({ name: userPasskeys.name })
			.from(userPasskeys)
			.where(
				and(eq(userPasskeys.id, passkeyId), eq(userPasskeys.userId, userId)),
			)
			.for("update");
		if (!passkey) return null;
		await tx
			.delete(userPasskeys)
			.where(
				and(eq(userPasskeys.id, passkeyId), eq(userPasskeys.userId, userId)),
			);
		return passkey;
	});
}
