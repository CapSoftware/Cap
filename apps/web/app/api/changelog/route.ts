import { NextResponse } from "next/server";
import { getChangelogPosts } from "../../../utils/changelog";
import { getCorsHeaders } from "../../../utils/cors";

export async function GET(request: Request) {
	const allUpdates = getChangelogPosts();

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

	const response = NextResponse.json(changelogs);

	const corsHeaders = getCorsHeaders(requestOrigin, origin);

	Object.entries(corsHeaders).forEach(([key, value]) => {
		response.headers.set(key, value);
	});

	return response;
}

export async function OPTIONS(request: Request) {
	const { origin } = new URL(request.url);
	const requestOrigin = request.headers.get("origin");

	const response = new NextResponse(null, { status: 204 });

	const corsHeaders = getCorsHeaders(requestOrigin, origin);

	Object.entries(corsHeaders).forEach(([key, value]) => {
		response.headers.set(key, value);
	});
	response.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
	response.headers.set("Access-Control-Allow-Headers", "Content-Type");

	return response;
}
