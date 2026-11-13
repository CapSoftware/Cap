import { classNames } from "@cap/utils/helpers";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import type { ReactNode } from "react";
import { CodePanel } from "./CodePanel";
import { type CodeSample, START } from "./content";
import { highlight } from "./highlight";
import { BODY, BTN_GHOST, BTN_PRIMARY, H_SECTION } from "./theme";

export const infraSans = Geist({
	subsets: ["latin"],
	weight: ["400", "500"],
	display: "swap",
	variable: "--font-infra-sans",
});

export const infraMono = Geist_Mono({
	subsets: ["latin"],
	weight: ["400"],
	display: "swap",
	preload: false,
	variable: "--font-infra-mono",
});

export const Code = ({
	samples,
	response,
	responseLabel,
	label,
	group,
	className,
}: {
	samples: readonly CodeSample[];
	response?: string;
	responseLabel?: string;
	label: string;
	group?: string;
	className?: string;
}) => (
	<CodePanel
		label={label}
		group={group}
		className={className}
		tabs={samples.map((sample) => ({
			id: sample.id,
			label: sample.label,
			code: sample.code,
			content: highlight(sample.code),
		}))}
		response={response ? highlight(response) : undefined}
		responseLabel={responseLabel}
	/>
);

export const SectionHeading = ({
	id,
	title,
	children,
	className,
}: {
	id?: string;
	title: string;
	children?: ReactNode;
	className?: string;
}) => (
	<div className={className}>
		<h2
			id={id}
			className={`${H_SECTION} m-0 text-balance text-[clamp(26px,2.7vw,34px)]`}
		>
			{title}
		</h2>
		{children ? (
			<div
				className={`${BODY} mt-4 max-w-[440px] text-pretty text-[15.5px] leading-[1.6] [&_p]:m-0 [&_p]:leading-[1.6]`}
			>
				{children}
			</div>
		) : null}
	</div>
);

export const Section = ({
	id,
	children,
	className,
}: {
	id?: string;
	children: ReactNode;
	className?: string;
}) => (
	<section
		id={id}
		className={classNames("scroll-mt-14 px-5 sm:px-8", className)}
	>
		<div className="mx-auto max-w-[1120px]">{children}</div>
	</section>
);

export const StartLink = ({ className }: { className?: string }) =>
	START.href.startsWith("/") ? (
		<Link href={START.href} className={className}>
			{START.label}
		</Link>
	) : (
		<a href={START.href} className={className}>
			{START.label}
		</a>
	);

export const Actions = ({
	secondary,
	className,
}: {
	secondary: { label: string; href: string };
	className?: string;
}) => (
	<div className={classNames("flex flex-wrap gap-2.5", className)}>
		<StartLink className={BTN_PRIMARY} />
		{secondary.href.startsWith("#") ? (
			<a href={secondary.href} className={BTN_GHOST}>
				{secondary.label}
			</a>
		) : (
			<Link href={secondary.href} className={BTN_GHOST}>
				{secondary.label}
			</Link>
		)}
	</div>
);
