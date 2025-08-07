import { db } from "../";
import { otpCodes } from "../schema";
import { eq, and, gt, gte, sql } from "drizzle-orm";
import { nanoId } from "../helpers";
import crypto from "crypto";

const OTP_EXPIRY_MINUTES = 10;
const MAX_ATTEMPTS = 3;
const MIN_TIME_BETWEEN_REQUESTS_MS = 30000;

export async function generateOTP(identifier: string): Promise<string> {
  const recentOTP = await db()
    .select()
    .from(otpCodes)
    .where(
      and(
        eq(otpCodes.identifier, identifier),
        gte(otpCodes.createdAt, new Date(Date.now() - MIN_TIME_BETWEEN_REQUESTS_MS))
      )
    )
    .limit(1);

  if (recentOTP.length > 0) {
    throw new Error("Please wait before requesting a new code");
  }

  const code = crypto.randomInt(100000, 1000000).toString();
  
  const expires = new Date();
  expires.setMinutes(expires.getMinutes() + OTP_EXPIRY_MINUTES);

  await db().delete(otpCodes).where(eq(otpCodes.identifier, identifier));

  await db().insert(otpCodes).values({
    id: nanoId(),
    identifier,
    code,
    expires,
    attempts: 0,
  });

  return code;
}

export async function validateOTP(
  identifier: string,
  code: string
): Promise<{ valid: boolean; error?: string }> {
  if (!code.match(/^\d{6}$/)) {
    return { valid: false, error: "Invalid code format" };
  }
  const otpRecord = await db()
    .select()
    .from(otpCodes)
    .where(
      and(
        eq(otpCodes.identifier, identifier),
        eq(otpCodes.code, code),
        gt(otpCodes.expires, new Date())
      )
    )
    .limit(1);

  if (otpRecord.length === 0) {
    const expiredRecord = await db()
      .select()
      .from(otpCodes)
      .where(
        and(
          eq(otpCodes.identifier, identifier),
          eq(otpCodes.code, code)
        )
      )
      .limit(1);

    if (expiredRecord.length > 0) {
      return { valid: false, error: "Code has expired" };
    }

    const activeRecord = await db()
      .select()
      .from(otpCodes)
      .where(
        and(
          eq(otpCodes.identifier, identifier),
          gt(otpCodes.expires, new Date())
        )
      )
      .limit(1);

    if (activeRecord.length > 0) {
      const record = activeRecord[0];
      
      if (record.attempts >= MAX_ATTEMPTS) {
        return { valid: false, error: "Too many attempts. Please request a new code." };
      }

      await db()
        .update(otpCodes)
        .set({ attempts: record.attempts + 1 })
        .where(eq(otpCodes.id, record.id));

      return { valid: false, error: "Invalid code" };
    }

    return { valid: false, error: "No active code found. Please request a new one." };
  }

  const record = otpRecord[0];

  if (record.attempts >= MAX_ATTEMPTS) {
    return { valid: false, error: "Too many attempts. Please request a new code." };
  }

  await db().delete(otpCodes).where(eq(otpCodes.id, record.id));

  return { valid: true };
}

export async function cleanupExpiredOTPs(): Promise<void> {
  await db().delete(otpCodes).where(gt(new Date(), otpCodes.expires));
}