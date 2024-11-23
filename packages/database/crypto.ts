import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const ITERATIONS = 100000;

const ENCRYPTION_KEY = process.env.DATABASE_ENCRYPTION_KEY as string;

// Verify the encryption key is valid hex and correct length
try {
  const keyBuffer = Buffer.from(ENCRYPTION_KEY, 'hex');
  if (keyBuffer.length !== KEY_LENGTH) {
    throw new Error(`Encryption key must be ${KEY_LENGTH} bytes (${KEY_LENGTH * 2} hex characters)`);
  }
} catch (error: unknown) {
  if (error instanceof Error) {
    throw new Error(`Invalid encryption key format: ${error.message}`);
  }
  throw new Error('Invalid encryption key format');
}

function deriveKey(salt: Buffer): Buffer {
  return pbkdf2Sync(
    ENCRYPTION_KEY,
    salt,
    ITERATIONS,
    KEY_LENGTH,
    'sha256'
  );
}

export function encrypt(text: string): string {
  if (!text) {
    throw new Error('Cannot encrypt empty or null text');
  }

  try {
    const salt = randomBytes(SALT_LENGTH);
    const iv = randomBytes(IV_LENGTH);
    const key = deriveKey(salt);
    
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    // Combine salt, IV, tag, and encrypted content
    const result = Buffer.concat([salt, iv, tag, encrypted]);
    return result.toString('base64');
  } catch (error: unknown) {
    if (error instanceof Error) {
      throw new Error(`Encryption failed: ${error.message}`);
    }
    throw new Error('Encryption failed');
  }
}

export function decrypt(encryptedText: string): string {
  if (!encryptedText) {
    throw new Error('Cannot decrypt empty or null text');
  }

  try {
    const encrypted = Buffer.from(encryptedText, 'base64');
    
    // Extract the components
    const salt = encrypted.subarray(0, SALT_LENGTH);
    const iv = encrypted.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const tag = encrypted.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
    const content = encrypted.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

    // Derive the same key using the extracted salt
    const key = deriveKey(salt);
    
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(content), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (error: unknown) {
    if (error instanceof Error) {
      throw new Error(`Decryption failed: ${error.message}`);
    }
    throw new Error('Decryption failed');
  }
} 