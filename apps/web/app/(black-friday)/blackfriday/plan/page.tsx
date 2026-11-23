import { getCurrentUser } from "@cap/database/auth/session";
import { userIsPro } from "@cap/utils";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCapFridayOffer } from "@/actions/billing/cap-friday";
import { PLAN_PATH } from "@/components/pages/blackfriday/content";
import { CapFridayPlan } from "@/components/pages/checkout/CapFridayPlan";
import { CAP_FRIDAY_CODE, capFridayLive } from "@/lib/checkout/cap-friday";
import { checkoutPath } from "@/lib/checkout/plans";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
	title: "Cap Friday for your plan | Cap",
	robots: { index: false, follow: false },
};

export default async function Page() {
	const user = await getCurrentUser();
	if (!user) {
		redirect(`/login?next=${encodeURIComponent(PLAN_PATH)}`);
	}
	// Not on Cap Pro yet: the code works in the normal yearly checkout.
	if (!userIsPro(user)) {
		redirect(
			checkoutPath({ plan: "yearly", seats: 1, promo: CAP_FRIDAY_CODE }),
		);
	}
	if (!capFridayLive()) redirect("/checkout?plan=yearly");

	return <CapFridayPlan state={await getCapFridayOffer()} />;
}
