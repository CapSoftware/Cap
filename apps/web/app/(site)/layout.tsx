import { buildEnv } from "@cap/env";
import "./tailwind-base.css";
import type { PropsWithChildren } from "react";
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
			<Navbar stars={stars} />
			{props.children}
			<Footer />
			{buildEnv.NEXT_PUBLIC_IS_CAP === "true" && <DeferredMessengerWidget />}
			{buildEnv.NEXT_PUBLIC_IS_CAP === "true" && <DubAnalytics />}
		</>
	);
}
