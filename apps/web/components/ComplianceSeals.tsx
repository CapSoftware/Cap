import type { ReactNode } from "react";

export const COMPLIANCE_SEALS: readonly {
	label: string;
	status: "compliant" | "in progress";
	content: ReactNode;
}[] = [
	{
		label: "SOC 2",
		status: "compliant",
		content: (
			<text
				x="22"
				y="25.5"
				textAnchor="middle"
				fontSize="8.5"
				fontWeight="700"
				letterSpacing="0.2"
				className="fill-current"
			>
				SOC 2
			</text>
		),
	},
	{
		label: "HIPAA",
		status: "compliant",
		content: (
			<text
				x="22"
				y="25.5"
				textAnchor="middle"
				fontSize="8"
				fontWeight="700"
				letterSpacing="0.1"
				className="fill-current"
			>
				HIPAA
			</text>
		),
	},
	{
		label: "ISO 27001",
		status: "compliant",
		content: (
			<>
				<text
					x="22"
					y="21"
					textAnchor="middle"
					fontSize="8.5"
					fontWeight="700"
					className="fill-current"
				>
					ISO
				</text>
				<text
					x="22"
					y="29.5"
					textAnchor="middle"
					fontSize="6.5"
					fontWeight="600"
					letterSpacing="0.4"
					className="fill-current"
				>
					27001
				</text>
			</>
		),
	},
];

export const ComplianceSeal = ({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) => (
	<svg viewBox="0 0 44 44" fill="none" aria-hidden="true" className={className}>
		<circle cx="22" cy="22" r="21" stroke="currentColor" />
		<circle
			cx="22"
			cy="22"
			r="17.5"
			stroke="currentColor"
			strokeDasharray="1 2.5"
		/>
		{children}
	</svg>
);
