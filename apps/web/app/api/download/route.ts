import { type NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

export async function GET(request: NextRequest) {
	const userAgent = request.headers.get("user-agent")?.toLowerCase() || "";
	const clientPlatform =
		request.headers
			.get("sec-ch-ua-platform")
			?.replaceAll('"', "")
			.toLowerCase() || "";

	let platform = "apple-silicon";

	if (clientPlatform.includes("windows") || userAgent.includes("windows")) {
		platform = "windows";
	} else if (clientPlatform.includes("macos") || userAgent.includes("mac")) {
		if (
			userAgent.includes("intel") ||
			userAgent.includes("x86_64") ||
			userAgent.includes("amd64")
		) {
			platform = "apple-intel";
		} else {
			platform = "apple-silicon";
		}
	} else if (
		clientPlatform.includes("linux") ||
		(userAgent.includes("linux") && !userAgent.includes("android"))
	) {
		platform = "linux-deb";
	}

	return NextResponse.redirect(new URL(`/download/${platform}`, request.url));
}
