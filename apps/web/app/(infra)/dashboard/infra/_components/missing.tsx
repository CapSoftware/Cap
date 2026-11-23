import type { ReactNode } from "react";
import { ButtonLink } from "./ui";

export function Missing({
	title,
	children,
	href,
	action,
}: {
	title: string;
	children: ReactNode;
	href: string;
	action: string;
}) {
	return (
		<div>
			<h1 className="m-0 text-[26px] font-medium leading-[1.15] tracking-[-0.03em] text-[#E8ECF4]">
				{title}
			</h1>
			<p className="m-0 mt-2 max-w-[520px] text-pretty text-[14.5px] leading-[1.55] text-[rgba(232,236,244,0.58)]">
				{children}
			</p>
			<ButtonLink href={href} variant="ghost" className="mt-6">
				{action}
			</ButtonLink>
		</div>
	);
}
