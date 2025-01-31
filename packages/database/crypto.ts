import { serverEnv } from "@cap/env";

const ALGORITHM = { name: "AES-GCM", length: 256 };
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;
const ITERATIONS = 100000;

const ENCRYPTION_KEY = serverEnv.DATABASE_ENCRYPTION_KEY as string;

// Verify the encryption key is valid hex and correct length
try {
  const keyBuffer = Buffer.from(ENCRYPTION_KEY, "hex");
  if (keyBuffer.length !== KEY_LENGTH) {
    throw new Error(
      `Encryption key must be ${KEY_LENGTH} bytes (${
        KEY_LENGTH * 2
      } hex characters)`
    );
  }
} catch (error: unknown) {
  if (error instanceof Error) {
    throw new Error(`Invalid encryption key format: ${error.message}`);
  }
  throw new Error("Invalid encryption key format");
}

async function deriveKey(salt: Uint8Array): Promise<CryptoKey> {
  // Convert hex string to ArrayBuffer for Web Crypto API
  const keyBuffer = Buffer.from(ENCRYPTION_KEY, "hex");

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    keyBuffer,
    "PBKDF2",
    false,
    ["deriveKey"]
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
    ["encrypt", "decrypt"]
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
      encoded
    );

    // Combine salt, IV, and encrypted content
    const result = Buffer.concat([
      Buffer.from(salt),
      Buffer.from(iv),
      Buffer.from(encrypted),
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

    // Extract the components
    const salt = encrypted.subarray(0, SALT_LENGTH);
    const iv = encrypted.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const content = encrypted.subarray(SALT_LENGTH + IV_LENGTH);

    // Derive the same key using the extracted salt
    const key = await deriveKey(salt);

    const decrypted = await crypto.subtle.decrypt(
      {
        name: ALGORITHM.name,
        iv,
      },
      key,
      content
    );

    return new TextDecoder().decode(decrypted);
  } catch (error: unknown) {
    if (error instanceof Error) {
      throw new Error(`Decryption failed: ${error.message}`);
    }
    throw new Error("Decryption failed");
  }
}
