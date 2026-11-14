import { firstPartyConnectionHandler } from "@/lib/app-store/first-party";

export async function POST(
	request: Request,
	context: { params: Promise<{ appId: string }> },
) {
	const { appId } = await context.params;
	const handler = firstPartyConnectionHandler(appId);
	if (!handler) return Response.json({ error: "Not found" }, { status: 404 });
	return handler(request);
}
