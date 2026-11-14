import { appStorePublicKeys } from "@/lib/app-store/signing";

export const dynamic = "force-dynamic";

export function GET() {
	return Response.json(appStorePublicKeys(), {
		headers: {
			"cache-control": "public, max-age=3600",
			"access-control-allow-origin": "*",
		},
	});
}
