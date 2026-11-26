import { getCurrentUser } from "@cap/database/auth/session";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PLAN_PATH } from "@/components/pages/blackfriday/content";
import { CAP_FRIDAY_CODE } from "@/lib/checkout/cap-friday";
import { checkoutPath } from "@/lib/checkout/plans";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
	title: "Cap Friday for your plan | Cap",
	robots: { index: false, follow: false },
};

export default async function Page() {
	const user = await getCurrentUser();
	if (!user) redirect(`/login?next=${encodeURIComponent(PLAN_PATH)}`);
	redirect(checkoutPath({ plan: "yearly", seats: 1, promo: CAP_FRIDAY_CODE }));
}
