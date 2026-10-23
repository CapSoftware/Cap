import { buildEnv, serverEnv } from "@cap/env";
import { type ClassValue, clsx } from "clsx";
import type { ReadonlyHeaders } from "next/dist/server/web/spec-extension/adapters/headers";
import type { NextRequest } from "next/server";
import { twMerge } from "tailwind-merge";

export function classNames(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

// Base allowed origins
export const allowedOrigins = [
	buildEnv.NEXT_PUBLIC_WEB_URL,
	"https://cap.link",
	"cap.link",
];

// Origins that are trusted to make credentialed (cookie-bearing) cross-origin
// reads. Only these may receive `Access-Control-Allow-Credentials: true` with a
// reflected origin. Any other origin gets a wildcard, credential-less response
// so a malicious site cannot read authenticated responses cross-origin.
function isTrustedCredentialedOrigin(origin: string) {
	let host: string;
	try {
		host = new URL(origin).hostname;
	} catch {
		return false;
	}

	if (host === "localhost" || host === "cap.so" || host === "cap.link")
		return true;
	if (host.endsWith(".cap.so")) return true;

	try {
		if (host === new URL(serverEnv().WEB_URL).hostname) return true;
	} catch {}

	return false;
}

export function getHeaders(origin: string | null): Record<string, string> {
	// Only reflect the specific origin + allow credentials for trusted origins.
	// Everyone else gets a wildcard with NO credentials so authenticated
	// responses can't be read cross-origin (credential-read CSRF).
	if (origin && isTrustedCredentialedOrigin(origin)) {
		return {
			"Access-Control-Allow-Origin": origin,
			"Access-Control-Allow-Credentials": "true",
			"Access-Control-Allow-Methods": "GET, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type, Authorization",
		};
	}

	return {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "GET, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type, Authorization",
	};
}

const rateLimitMap = new Map();

export function rateLimitMiddleware(
	limit: number,
	request: NextRequest | Promise<Response>,
	headersList: ReadonlyHeaders,
) {
	const ip = headersList.get("x-forwarded-for");
	const windowMs = 60 * 1000;

	if (!rateLimitMap.has(ip)) {
		rateLimitMap.set(ip, {
			count: 0,
			lastReset: Date.now(),
		});
	}

	const ipData = rateLimitMap.get(ip) as {
		count: number;
		lastReset: number;
	};

	if (Date.now() - ipData.lastReset > windowMs) {
		ipData.count = 0;
		ipData.lastReset = Date.now();
	}

	if (ipData.count >= limit) {
		return new Response("Too many requests", {
			status: 429,
		});
	}

	ipData.count += 1;

	return request;
}

export const CACHE_CONTROL_HEADERS = {
	"Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
	Pragma: "no-cache",
	Expires: "0",
};
