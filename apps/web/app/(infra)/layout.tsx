import { buildEnv } from "@cap/env";
import "../(site)/tailwind-base.css";
import type { PropsWithChildren } from "react";
import { htSans } from "@/components/pages/HomeTwo/fonts";
import { Footer } from "@/components/pages/infra/Footer";
import { Header } from "@/components/pages/infra/Header";
import { Grain } from "@/components/pages/infra/Plain";
import { infraMono } from "@/components/pages/infra/shared";
import { DubAnalytics } from "@/components/referrals/DubAnalytics";

export default function InfraLayout(props: PropsWithChildren) {
	return (
		<div
			className={`${htSans.className} ${htSans.variable} ${infraMono.variable} relative min-h-screen bg-[#0E0F10] text-[#ECE8E1] antialiased [color-scheme:dark]`}
		>
			<style>{"html,body{background:#0E0F10}"}</style>
			<Header />
			{props.children}
			<Footer />
			<Grain />
			{buildEnv.NEXT_PUBLIC_IS_CAP === "true" && <DubAnalytics />}
		</div>
	);
}
