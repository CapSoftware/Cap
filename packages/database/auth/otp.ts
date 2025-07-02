import { db } from "../";
import { verificationTokens } from "../schema";
import { eq, and, gt, lt } from "drizzle-orm";
import crypto from "crypto";

export function generateOTP(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

export async function createOTP(email: string): Promise<string> {

  const otp = generateOTP();
  const expires = new Date();
  expires.setMinutes(expires.getMinutes() + 10);

  await db()
    .delete(verificationTokens)
    .where(eq(verificationTokens.identifier, email));

  await db().insert(verificationTokens).values({
    identifier: email,
    token: otp,
    expires: expires,
  });

  return otp;
}

export async function verifyOTP(email: string, otp: string): Promise<boolean> {
  if (!email || !otp || otp.length !== 6 || !/^\d{6}$/.test(otp)) {
    return false;
  }

  const tokens = await db()
    .select()
    .from(verificationTokens)
    .where(
      and(
        eq(verificationTokens.identifier, email),
        gt(verificationTokens.expires, new Date())
      )
    )
    .limit(1);

  if (tokens.length === 0) {
    return false;
  }

  const storedOtp = tokens[0].token;
  
  const isValid = crypto.timingSafeEqual(
    Buffer.from(otp),
    Buffer.from(storedOtp)
  );

  if (isValid) {
    await db()
      .delete(verificationTokens)
      .where(
        and(
          eq(verificationTokens.identifier, email),
          eq(verificationTokens.token, otp)
        )
      );
  }

  return isValid;
}

export async function cleanupExpiredOTPs() {
  await db()
    .delete(verificationTokens)
    .where(lt(verificationTokens.expires, new Date()));
} 