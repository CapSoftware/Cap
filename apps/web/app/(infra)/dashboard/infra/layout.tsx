import type { Metadata } from "next";
import { infraMono, infraSans } from "./_components/fonts";

export const metadata: Metadata = {
	title: "Cap Infra",
};

export default function InfraLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<div
			className={`${infraSans.variable} ${infraMono.variable} min-h-dvh bg-[#050506] text-[#E8ECF4] antialiased [color-scheme:dark] [font-family:var(--font-infra-sans),system-ui,sans-serif]`}
		>
			<style>{"html,body{background:#050506}"}</style>
			{children}
		</div>
	);
}
