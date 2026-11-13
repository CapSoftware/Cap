import type { PropsWithChildren } from "react";
import { infraSans } from "@/app/(infra)/dashboard/infra/_components/fonts";

export default function DeveloperVideoLayout({ children }: PropsWithChildren) {
	return (
		<div
			className={`${infraSans.variable} text-[#E8ECF4] antialiased [color-scheme:dark] [font-family:var(--font-infra-sans),system-ui,sans-serif]`}
		>
			<style>{"html,body{background:#050506}"}</style>
			{children}
		</div>
	);
}
