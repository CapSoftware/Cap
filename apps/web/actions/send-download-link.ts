"use server";

import { sendEmail } from "@cap/database/emails/config";
import { DownloadLink } from "@cap/database/emails/download-link";
import { checkRateLimit } from "@vercel/firewall";
import { headers } from "next/headers";

function sanitizeEmail(raw: string): string | null {
	const stripped = raw
		.replace(/<[^>]*>/g, "")
		.trim()
		.toLowerCase();

	if (stripped.length === 0 || stripped.length > 254) {
		return null;
	}

	if (
		!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
			stripped,
		)
	) {
		return null;
	}

	return stripped;
}

export async function sendDownloadLink(email: string) {
	const sanitized = sanitizeEmail(email);
	if (!sanitized) {
		return { success: false, error: "Please enter a valid email address." };
	}

	const headersList = await headers();
	const request = new Request("https://cap.so/api/send-download-link", {
		method: "POST",
		headers: headersList,
	});

	const { rateLimited } = await checkRateLimit("rl_send_download_link", {
		request,
	});

	if (rateLimited) {
		return {
			success: false,
			error: "You've sent too many requests. Please try again later.",
		};
	}

	try {
		await sendEmail({
			email: sanitized,
			subject: "Your Cap download links",
			react: DownloadLink({ email: sanitized }),
			marketing: true,
		});

		return { success: true };
	} catch {
		return { success: false, error: "Something went wrong. Please try again." };
	}
}
