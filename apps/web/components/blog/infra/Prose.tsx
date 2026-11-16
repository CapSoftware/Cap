import type { MDXComponents } from "mdx/types";
import Link from "next/link";
import { H_SECTION, TEXT_LINK } from "@/components/pages/infra/theme";

const TEXT = "text-[17px] leading-[1.75] text-[rgba(232,236,244,0.7)]";

export const infraProse: MDXComponents = {
	h2: (props) => (
		<h2
			{...props}
			className={`${H_SECTION} mb-5 mt-16 text-[26px] sm:mt-20 sm:text-[30px]`}
		/>
	),
	h3: (props) => (
		<h3
			{...props}
			className="mb-3 mt-10 text-[19px] font-medium leading-[1.3] tracking-[-0.015em] text-[#E8ECF4]"
		/>
	),
	p: (props) => <p {...props} className={`${TEXT} my-5`} />,
	ul: (props) => (
		<ul
			{...props}
			className="my-6 list-disc space-y-3 pl-5 marker:text-[rgba(232,236,244,0.3)]"
		/>
	),
	li: (props) => <li {...props} className={`${TEXT} pl-1`} />,
	strong: (props) => (
		<strong {...props} className="font-medium text-[#E8ECF4]" />
	),
	a: ({ href = "", children }) =>
		href.startsWith("/") ? (
			<Link href={href} className={`${TEXT_LINK} text-[#E8ECF4]`}>
				{children}
			</Link>
		) : (
			<a
				href={href}
				target="_blank"
				rel="noreferrer"
				className={`${TEXT_LINK} text-[#E8ECF4]`}
			>
				{children}
			</a>
		),
};
