import { buildEnv } from "@cap/env";
import { serverEnv } from "@cap/env/server";
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

export function getHeaders(origin: string | null) {
	// Allow "*" for custom domains or allowedOrigins for main domains
	return {
		"Access-Control-Allow-Origin": origin || "*",
		"Access-Control-Allow-Credentials": "true",
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
