import { buildEnv } from "@cap/env";
import "./tailwind-base.css";
import type { PropsWithChildren } from "react";
import { ENDS_AT } from "@/components/pages/blackfriday/content";
import { SiteBanner } from "@/components/pages/blackfriday/SiteBanner";
import { DubAnalytics } from "@/components/referrals/DubAnalytics";
import { formatStarCount, getGitHubStars } from "@/utils/github";
import { DeferredMessengerWidget } from "../Layout/DeferredMessengerWidget";
import { Footer } from "./Footer";
import { Navbar } from "./Navbar";

export default async function Layout(props: PropsWithChildren) {
	const starCount = await getGitHubStars();
	const stars = formatStarCount(starCount);

	return (
		<>
			{buildEnv.NEXT_PUBLIC_IS_CAP === "true" && Date.now() < ENDS_AT && (
				<SiteBanner />
			)}
			<Navbar stars={stars} />
			{props.children}
			<Footer />
			{buildEnv.NEXT_PUBLIC_IS_CAP === "true" && <DeferredMessengerWidget />}
			{buildEnv.NEXT_PUBLIC_IS_CAP === "true" && <DubAnalytics />}
		</>
	);
}
