// TODO: port this all to Effect

import { timingSafeEqual } from "node:crypto";
import { serverEnv } from "@inflight/env";

const ALGORITHM = { name: "AES-GCM", length: 256 };
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;
const ITERATIONS = 100000;

const ENCRYPTION_KEY = () => {
	const key = serverEnv().DATABASE_ENCRYPTION_KEY;
	if (!key) return;

	try {
		const keyBuffer = Buffer.from(key, "hex");
		if (keyBuffer.length !== KEY_LENGTH) {
			throw new Error(
				`Encryption key must be ${KEY_LENGTH} bytes (${
					KEY_LENGTH * 2
				} hex characters)`,
			);
		}
	} catch (error: unknown) {
		if (error instanceof Error) {
			throw new Error(`Invalid encryption key format: ${error.message}`);
		}
		throw new Error("Invalid encryption key format");
	}

	return key;
};

async function deriveKey(salt: Uint8Array): Promise<CryptoKey> {
	const key = ENCRYPTION_KEY();
	if (!key) throw new Error("Encryption key is not available");

	const keyBuffer = Buffer.from(key, "hex");

	const keyMaterial = await crypto.subtle.importKey(
		"raw",
		keyBuffer,
		"PBKDF2",
		false,
		["deriveKey"],
	);

	return crypto.subtle.deriveKey(
		{
			name: "PBKDF2",
			salt,
			iterations: ITERATIONS,
			hash: "SHA-256",
		},
		keyMaterial,
		ALGORITHM,
		false,
		["encrypt", "decrypt"],
	);
}

export async function encrypt(text: string): Promise<string> {
	if (!text) {
		throw new Error("Cannot encrypt empty or null text");
	}

	try {
		const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
		const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
		const key = await deriveKey(salt);

		const encoded = new TextEncoder().encode(text);
		const encrypted = await crypto.subtle.encrypt(
			{
				name: ALGORITHM.name,
				iv,
			},
			key,
			encoded,
		);

		const result = Buffer.concat([
			Buffer.from(salt as any) as any,
			Buffer.from(iv as any) as any,
			Buffer.from(encrypted as any) as any,
		]);

		return result.toString("base64");
	} catch (error: unknown) {
		if (error instanceof Error) {
			throw new Error(`Encryption failed: ${error.message}`);
		}
		throw new Error("Encryption failed");
	}
}

export async function decrypt(encryptedText: string): Promise<string> {
	if (!encryptedText) {
		throw new Error("Cannot decrypt empty or null text");
	}

	try {
		const encrypted = Buffer.from(encryptedText, "base64");

		const salt = encrypted.subarray(0, SALT_LENGTH);
		const iv = encrypted.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
		const content = encrypted.subarray(SALT_LENGTH + IV_LENGTH);

		const key = await deriveKey(salt as Uint8Array);

		const decrypted = await crypto.subtle.decrypt(
			{
				name: ALGORITHM.name,
				iv,
			},
			key,
			content,
		);

		return new TextDecoder().decode(decrypted);
	} catch (error: unknown) {
		if (error instanceof Error) {
			throw new Error(`Decryption failed: ${error.message}`);
		}
		throw new Error("Decryption failed");
	}
}

const PASSWORD_KEY_LENGTH = 32;
const PASSWORD_ITERATIONS = 100000;
const PASSWORD_HASH = "SHA-256";

export async function hashPassword(password: string): Promise<string> {
	if (!password) {
		throw new Error("Cannot hash empty or null password");
	}

	const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
	const keyMaterial = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		"PBKDF2",
		false,
		["deriveBits"],
	);

	const derived = await crypto.subtle.deriveBits(
		{
			name: "PBKDF2",
			salt,
			iterations: PASSWORD_ITERATIONS,
			hash: PASSWORD_HASH,
		},
		keyMaterial,
		PASSWORD_KEY_LENGTH * 8,
	);

	const result = Buffer.concat([
		Buffer.from(salt as any) as any,
		Buffer.from(derived as any) as any,
	]);

	return result.toString("base64");
}

export async function verifyPassword(
	stored: string,
	password: string,
): Promise<boolean> {
	if (!stored || !password) return false;

	const data = Buffer.from(stored, "base64");
	const salt = data.subarray(0, SALT_LENGTH);
	const hash = data.subarray(SALT_LENGTH);

	const keyMaterial = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		"PBKDF2",
		false,
		["deriveBits"],
	);

	const derived = await crypto.subtle.deriveBits(
		{
			name: "PBKDF2",
			salt,
			iterations: PASSWORD_ITERATIONS,
			hash: PASSWORD_HASH,
		},
		keyMaterial,
		PASSWORD_KEY_LENGTH * 8,
	);

	return timingSafeEqual(Buffer.from(hash), Buffer.from(derived));
}
