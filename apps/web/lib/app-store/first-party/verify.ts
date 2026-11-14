import "server-only";

import { type CapRequest, verifyCapRequest } from "@cap/app-store";
import { appStorePublicKeys } from "../signing";

export type VerifiedCapRequest =
	| { ok: true; request: CapRequest; path: string }
	| { ok: false; response: Response };

const json = (status: number, body: unknown) =>
	Response.json(body, { status, headers: { "cache-control": "no-store" } });

export async function readVerifiedCapRequest(
	request: Request,
	prefix: string,
): Promise<VerifiedCapRequest> {
	if (request.method !== "POST") {
		return { ok: false, response: json(405, { error: "Method not allowed" }) };
	}
	const body = await request.text();
	const verified = verifyCapRequest({
		headers: request.headers,
		body,
		keys: appStorePublicKeys(),
	});
	if (!verified.ok) {
		return { ok: false, response: json(401, { error: verified.reason }) };
	}
	let parsed: CapRequest;
	try {
		parsed = JSON.parse(body) as CapRequest;
	} catch {
		return { ok: false, response: json(400, { error: "Invalid JSON" }) };
	}
	if (parsed.kind !== verified.kind) {
		return { ok: false, response: json(400, { error: "Kind mismatch" }) };
	}
	const pathname = new URL(request.url).pathname;
	const path = pathname.startsWith(prefix)
		? pathname.slice(prefix.length).replace(/^\//, "")
		: "";
	return { ok: true, request: parsed, path };
}

export const capJson = json;
