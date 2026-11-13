import { buildEnv } from "@cap/env";
import "../(site)/tailwind-base.css";
import type { PropsWithChildren } from "react";
import { Footer } from "@/components/pages/infra/Footer";
import { Header } from "@/components/pages/infra/Header";
import { Grain } from "@/components/pages/infra/Plain";
import { infraMono, infraSans } from "@/components/pages/infra/shared";
import { DubAnalytics } from "@/components/referrals/DubAnalytics";

export default function InfraLayout(props: PropsWithChildren) {
	return (
		<div
			className={`${infraSans.className} ${infraSans.variable} ${infraMono.variable} relative min-h-screen overflow-x-clip bg-[#050506] text-[#E8ECF4] antialiased [color-scheme:dark]`}
		>
			<style>{"html,body{background:#050506}"}</style>
			<Header />
			{props.children}
			<Footer />
			<Grain />
			{buildEnv.NEXT_PUBLIC_IS_CAP === "true" && <DubAnalytics />}
		</div>
	);
}
