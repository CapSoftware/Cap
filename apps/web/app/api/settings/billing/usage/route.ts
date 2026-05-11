import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { userIsPro } from "@cap/utils";
import {
	getShareableLinkPeriod,
	getShareableLinkUsage,
	toShareableLinkUsageSnapshot,
} from "@cap/web-backend";

export const dynamic = "force-dynamic";

export async function GET() {
	const user = await getCurrentUser();

	if (!user) {
		return Response.json({ auth: false }, { status: 401 });
	}

	const isPro = userIsPro(user);
	const usage = isPro
		? toShareableLinkUsageSnapshot(0, getShareableLinkPeriod().resetAt)
		: await getShareableLinkUsage(db(), user.id);

	if (isPro) {
		return Response.json(
			{
				subscription: true,
				videoLimit: 0,
				videoCount: usage.used,
				shareableLinkUsage: usage,
			},
			{ status: 200 },
		);
	} else {
		return Response.json(
			{
				subscription: false,
				videoLimit: usage.limit,
				videoCount: usage.used,
				shareableLinkUsage: usage,
			},
			{ status: 200 },
		);
	}
}
