import { buildEnv } from "@cap/env";
import type { NextRequest } from "next/server";
import { getMessengerConversationUpdates } from "@/lib/messenger/data";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

const empty = (status: number) =>
	new Response(null, { status, headers: NO_STORE });

export async function GET(
	request: NextRequest,
	props: RouteContext<"/api/messenger/conversations/[id]/updates">,
) {
	if (buildEnv.NEXT_PUBLIC_IS_CAP !== "true") return empty(404);
	if (
		await isRateLimited(RATE_LIMIT_IDS.MESSENGER_POLL, {
			headers: request.headers,
		})
	)
		return empty(429);

	const { id } = await props.params;
	const { searchParams } = request.nextUrl;
	const updates = await getMessengerConversationUpdates({
		conversationId: id,
		after: searchParams.get("after"),
	});
	if (!updates) return empty(404);

	if (!updates.messages.length && updates.mode === searchParams.get("mode"))
		return empty(204);

	return Response.json(
		{
			mode: updates.mode,
			messages: updates.messages.map((message) => ({
				id: message.id,
				role: message.role,
				content: message.content,
				createdAt: message.createdAt.toISOString(),
			})),
		},
		{ headers: NO_STORE },
	);
}
