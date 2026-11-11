import { classNames } from "@cap/utils/helpers";
import { DM_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { CodePanel } from "./CodePanel";
import type { CodeSample } from "./content";
import { highlight } from "./highlight";
import { BODY, H_SECTION } from "./theme";

export const infraMono = DM_Mono({
	subsets: ["latin"],
	weight: ["400"],
	display: "swap",
	variable: "--font-ht-mono",
});

export const Code = ({
	samples,
	response,
	label,
	className,
}: {
	samples: readonly CodeSample[];
	response?: string;
	label: string;
	className?: string;
}) => (
	<CodePanel
		label={label}
		className={className}
		tabs={samples.map((sample) => ({
			id: sample.id,
			label: sample.label,
			code: sample.code,
			content: highlight(sample.code),
		}))}
		response={response ? highlight(response) : undefined}
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
			className={`${H_SECTION} scroll-mt-24 text-balance text-[clamp(32px,4vw,50px)]`}
		>
			{title}
		</h2>
		{children ? (
			<div
				className={`${BODY} mt-5 max-w-[500px] text-pretty text-[16px] leading-[1.6] sm:text-[17px] [&_p]:leading-[1.6]`}
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
		className={classNames(
			"scroll-mt-16 border-t border-[rgba(236,232,225,0.07)] px-5 py-20 lg:py-28",
			className,
		)}
	>
		<div className="mx-auto max-w-[1160px]">{children}</div>
	</section>
);
