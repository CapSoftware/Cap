import { getMobileCheckoutDeepLink } from "@/lib/mobile-checkout";

export function GET(request: Request) {
	const checkout = new URL(request.url).searchParams.get("checkout");
	const result = checkout === "success" ? "success" : "cancelled";

	return Response.redirect(getMobileCheckoutDeepLink(result), 302);
}
