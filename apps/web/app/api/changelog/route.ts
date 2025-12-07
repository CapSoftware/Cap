import { NextResponse } from "next/server";
import { getChangelogPosts } from "../../../utils/changelog";
import { getCorsHeaders } from "../../../utils/cors";

export async function GET(request: Request) {
	console.log("[Changelog] Request received");

	const allUpdates = getChangelogPosts();
	console.log("[Changelog] Found updates:", allUpdates.length);

	const changelogs = allUpdates
		.map((post) => ({
			metadata: post.metadata,
			content: post.content,
			slug: parseInt(post.slug, 10),
		}))
		.sort((a, b) => b.slug - a.slug)
		.map(({ metadata, content }) => ({ ...metadata, content }));

	const { origin } = new URL(request.url);
	const requestOrigin = request.headers.get("origin");

	console.log("[Changelog] Request details:", {
		url: request.url,
		origin,
		requestOrigin,
		headers: Object.fromEntries(request.headers.entries()),
	});

	const response = NextResponse.json(changelogs);

	// Set CORS headers using the utility function
	const corsHeaders = getCorsHeaders(requestOrigin, origin);
	console.log("[Changelog] Setting CORS headers:", corsHeaders);

	Object.entries(corsHeaders).forEach(([key, value]) => {
		response.headers.set(key, value);
	});

	console.log(
		"[Changelog] Response headers:",
		Object.fromEntries(response.headers.entries()),
	);
	return response;
}

export async function OPTIONS(request: Request) {
	console.log("[Changelog OPTIONS] Request received");

	const { origin } = new URL(request.url);
	const requestOrigin = request.headers.get("origin");

	console.log("[Changelog OPTIONS] Request details:", {
		url: request.url,
		origin,
		requestOrigin,
		headers: Object.fromEntries(request.headers.entries()),
	});

	const response = new NextResponse(null, { status: 204 });

	// Set CORS headers using the utility function
	const corsHeaders = getCorsHeaders(requestOrigin, origin);
	console.log("[Changelog OPTIONS] Setting CORS headers:", corsHeaders);

	Object.entries(corsHeaders).forEach(([key, value]) => {
		response.headers.set(key, value);
	});
	response.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
	response.headers.set("Access-Control-Allow-Headers", "Content-Type");

	console.log(
		"[Changelog OPTIONS] Response headers:",
		Object.fromEntries(response.headers.entries()),
	);
	return response;
}
