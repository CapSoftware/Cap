import { buildEnv } from "@cap/env";
import "../(site)/tailwind-base.css";
import type { PropsWithChildren } from "react";
import { PublicPageProviders } from "@/app/Layout/PublicPageProviders";
import { DubAnalytics } from "@/components/referrals/DubAnalytics";

export default function BlackFridayLayout(props: PropsWithChildren) {
	return (
		<PublicPageProviders>
			{props.children}
			{buildEnv.NEXT_PUBLIC_IS_CAP === "true" && <DubAnalytics />}
		</PublicPageProviders>
	);
}
