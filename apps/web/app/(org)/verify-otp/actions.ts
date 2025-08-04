"use server";

import { validateOTP } from "@cap/database/auth/otp";

export async function verifyOTPAction(email: string, code: string) {
  try {
    if (!email || !code) {
      return { success: false, error: "Email and code are required" };
    }

    const result = await validateOTP(email, code);

    if (result.valid) {
      return { success: true };
    } else {
      return { success: false, error: result.error || "Invalid code" };
    }
  } catch (error) {
    console.error("OTP verification error:", error);
    return { success: false, error: "An error occurred during verification" };
  }
}