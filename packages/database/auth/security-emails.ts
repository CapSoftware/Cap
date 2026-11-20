import { buildEnv, serverEnv } from "@cap/env";
import { getEmailDeliveryStatus, sendEmail } from "../emails/config.ts";

export async function sendAccountSecurityCode(email: string, code: string) {
	const emailStatus = getEmailDeliveryStatus();
	if (!emailStatus.configured) {
		if (
			process.env.NODE_ENV === "production" &&
			buildEnv.NEXT_PUBLIC_IS_CAP === "true"
		) {
			throw new Error(emailStatus.reason);
		}
		console.log(
			`\n🔐 ACCOUNT SECURITY CODE (email delivery disabled)\nℹ️  ${emailStatus.reason}\n📧 Email: ${email}\n🔢 Code: ${code}\n⏱  Expires in: 10 minutes\n`,
		);
		return;
	}
	const { AccountSecurityCodeEmail } = await import(
		"../emails/account-security-code"
	);
	const delivery = await sendEmail({
		email,
		subject: "Your Cap security code",
		react: AccountSecurityCodeEmail({ email, code }),
	});
	if (delivery?.error) {
		throw new Error(
			`Failed to send security code email: ${delivery.error.message}`,
		);
	}
}

export async function sendPasskeyAddedNotice(
	email: string,
	passkeyName: string,
) {
	if (!getEmailDeliveryStatus().configured) return;
	try {
		const { PasskeyAddedEmail } = await import("../emails/passkey-added");
		const settingsUrl = new URL(
			"/dashboard/settings/account",
			serverEnv().WEB_URL,
		).toString();
		await sendEmail({
			email,
			subject: "A passkey was added to your Cap account",
			react: PasskeyAddedEmail({ email, passkeyName, settingsUrl }),
		});
	} catch (error) {
		console.error("[passkeys] Failed to send passkey added notice", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export async function sendPasskeyRemovedNotice(
	email: string,
	passkeyName: string,
) {
	if (!getEmailDeliveryStatus().configured) return;
	try {
		const { PasskeyRemovedEmail } = await import("../emails/passkey-removed");
		const settingsUrl = new URL(
			"/dashboard/settings/account",
			serverEnv().WEB_URL,
		).toString();
		await sendEmail({
			email,
			subject: "A passkey was removed from your Cap account",
			react: PasskeyRemovedEmail({ email, passkeyName, settingsUrl }),
		});
	} catch (error) {
		console.error("[passkeys] Failed to send passkey removed notice", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
