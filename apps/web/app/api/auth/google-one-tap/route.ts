import {
	createGoogleOneTapNonce,
	googleOneTapNonceCookieForWebUrl,
} from "@cap/database/auth/google-one-tap";
import { serverEnv } from "@cap/env";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST() {
	const env = serverEnv();
	if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}
	const nonce = createGoogleOneTapNonce();
	const cookie = googleOneTapNonceCookieForWebUrl(env.WEB_URL);
	const response = NextResponse.json({ nonce });
	response.headers.set("cache-control", "no-store");
	response.cookies.set(cookie.name, nonce, cookie.options);
	return response;
}
