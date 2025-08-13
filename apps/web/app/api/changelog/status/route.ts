import { NextResponse } from "next/server";
import { getChangelogPosts } from "../../../../utils/changelog";

export const revalidate = 0;

export async function GET(request: Request) {
	const { searchParams } = new URL(request.url);
	const version = searchParams.get("version");

	const allUpdates = getChangelogPosts();

	const changelogs: {
		content: string;
		title: string;
		app: string;
		publishedAt: string;
		version: string;
		image?: string;
	}[] = allUpdates
		.map((post) => ({
			metadata: post.metadata,
			content: post.content,
			slug: parseInt(post.slug),
		}))
		.sort((a, b) => b.slug - a.slug)
		.map(({ metadata, content }) => ({ ...metadata, content }));

	if (changelogs.length === 0) {
		return NextResponse.json({ hasUpdate: false });
	}

	const firstChangelog = changelogs[0];
	if (!firstChangelog) {
		return NextResponse.json({ hasUpdate: false });
	}

	const latestVersion = firstChangelog.version;
	const hasUpdate = version ? latestVersion === version : false;

	const response = NextResponse.json({ hasUpdate });

	// Set CORS headers
	response.headers.set("Access-Control-Allow-Origin", "*");
	response.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
	response.headers.set("Access-Control-Allow-Headers", "Content-Type");

	return response;
}

export async function OPTIONS() {
	const response = new NextResponse(null, { status: 204 });

	// Set CORS headers for preflight requests
	response.headers.set("Access-Control-Allow-Origin", "*");
	response.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
	response.headers.set("Access-Control-Allow-Headers", "Content-Type");

	return response;
}
