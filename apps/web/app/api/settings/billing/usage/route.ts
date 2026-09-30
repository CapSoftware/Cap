import { getCurrentUser } from "@cap/database/auth/session";
import { userIsPro } from "@cap/utils";
import { getShareableLinkUsage } from "@/lib/shareable-link-quota";

export const dynamic = "force-dynamic";

export async function GET() {
	const user = await getCurrentUser();

	if (!user) {
		return Response.json({ auth: false }, { status: 401 });
	}

	const usage = await getShareableLinkUsage(user.id);

	if (userIsPro(user)) {
		return Response.json(
			{
				subscription: true,
				videoLimit: 0,
				videoCount: usage.used,
			},
			{ status: 200 },
		);
	}

	return Response.json(
		{
			subscription: false,
			videoLimit: usage.limit,
			videoCount: usage.used,
		},
		{ status: 200 },
	);
}
