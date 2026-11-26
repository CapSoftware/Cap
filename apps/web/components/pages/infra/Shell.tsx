import { buildEnv } from "@cap/env";
import type { ReactNode } from "react";
import { DubAnalytics } from "@/components/referrals/DubAnalytics";
import { Footer } from "./Footer";
import { Header } from "./Header";
import { Grain } from "./Plain";
import { infraMono, infraSans } from "./shared";

/**
 * The night page every Cap Infra route sits on. `anchorBase` is where the
 * header and footer section links point: empty on /infra itself, "/infra"
 * on pages that live elsewhere.
 */
export function InfraShell({
	anchorBase = "",
	children,
}: {
	anchorBase?: string;
	children: ReactNode;
}) {
	return (
		<div
			className={`${infraSans.className} ${infraSans.variable} ${infraMono.variable} relative min-h-screen overflow-x-clip bg-[#050506] text-[#E8ECF4] antialiased [color-scheme:dark]`}
		>
			<style>{"html,body{background:#050506}"}</style>
			<Header anchorBase={anchorBase} />
			{children}
			<Footer anchorBase={anchorBase} />
			<Grain />
			{buildEnv.NEXT_PUBLIC_IS_CAP === "true" && <DubAnalytics />}
		</div>
	);
}
