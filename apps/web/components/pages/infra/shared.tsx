import { classNames } from "@cap/utils/helpers";
import { DM_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { BODY_TEXT, H_SECTION } from "@/components/pages/HomeTwo/theme";
import { CodePanel } from "./CodePanel";
import type { CodeSample } from "./content";
import { highlight } from "./highlight";

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
			className={`${H_SECTION} scroll-mt-24 text-balance text-[clamp(34px,4.2vw,52px)]`}
		>
			{title}
		</h2>
		{children ? (
			<div
				className={`${BODY_TEXT} mt-5 max-w-[520px] text-pretty text-[16.5px] leading-[1.55] text-[rgba(17,17,17,0.74)] sm:text-[17.5px]`}
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
		className={classNames("scroll-mt-20 px-5 py-20 lg:py-28", className)}
	>
		<div className="mx-auto max-w-[1160px]">{children}</div>
	</section>
);
