import { buildEnv } from "@cap/env";
import "../(site)/tailwind-base.css";
import type { PropsWithChildren } from "react";
import { htSans, htSerif } from "@/components/pages/HomeTwo/fonts";
import { Footer } from "@/components/pages/infra/Footer";
import { Header } from "@/components/pages/infra/Header";
import { infraMono } from "@/components/pages/infra/shared";
import { DubAnalytics } from "@/components/referrals/DubAnalytics";

export default function InfraLayout(props: PropsWithChildren) {
	return (
		<div
			className={`${htSans.className} ${htSans.variable} ${htSerif.variable} ${infraMono.variable} min-h-screen bg-white text-[#111111]`}
		>
			<Header />
			{props.children}
			<Footer />
			{buildEnv.NEXT_PUBLIC_IS_CAP === "true" && <DubAnalytics />}
		</div>
	);
}
