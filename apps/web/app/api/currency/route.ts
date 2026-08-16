import type { NextRequest } from "next/server";
import { currencyForCountry } from "@/utils/currency";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
	const override =
		process.env.VERCEL_ENV !== "production"
			? request.nextUrl.searchParams.get("country")
			: null;
	const country = override || request.headers.get("x-vercel-ip-country");

	return Response.json(
		{ currency: currencyForCountry(country), country: country ?? null },
		{
			// The response varies per visitor IP, so it must never land in a shared
			// CDN cache where one region's currency would be served to another.
			headers: { "Cache-Control": "private, no-store" },
		},
	);
}
