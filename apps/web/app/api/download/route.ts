import { type NextRequest, NextResponse } from "next/server";

export const runtime = "edge";
export const revalidate = 0;

export async function GET(request: NextRequest) {
	const userAgent = request.headers.get("user-agent") || "";

	let platform = "apple-silicon";

	if (userAgent.includes("Windows")) {
		platform = "windows";
	} else if (userAgent.includes("Mac")) {
		if (userAgent.includes("Intel")) {
			platform = "apple-intel";
		} else {
			platform = "apple-silicon";
		}
	}

	return NextResponse.redirect(new URL(`/download/${platform}`, request.url));
}
