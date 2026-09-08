"use client";

import { Button, Card, CardDescription, CardHeader, CardTitle } from "@cap/ui";
import type { ReactNode } from "react";

const TRUST_PORTAL_URL = "https://trust.cap.so";

const certifications: {
	label: string;
	description: string;
	badge: ReactNode;
}[] = [
	{
		label: "SOC 2 Type II",
		description:
			"Independently audited security, availability, and confidentiality controls, tested continuously over time.",
		badge: (
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
		label: "ISO 27001",
		description:
			"Certified information security management system covering risk, access, incident response, and vendors.",
		badge: (
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
	{
		label: "HIPAA",
		description:
			"HIPAA compliance verified through Comp AI, with every vendor in Cap's production infrastructure covered by a BAA.",
		badge: (
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
];

export function ComplianceCard() {
	return (
		<Card>
			<div className="flex flex-wrap gap-6 justify-between items-start">
				<CardHeader>
					<CardTitle>Security & Compliance</CardTitle>
					<CardDescription>
						Cap is SOC 2 Type II, ISO 27001, and HIPAA compliant. Our compliance
						program is completed and continuously monitored through Comp AI.
					</CardDescription>
				</CardHeader>
				<Button
					type="button"
					size="sm"
					variant="gray"
					onClick={() => {
						window.open(TRUST_PORTAL_URL, "_blank", "noopener,noreferrer");
					}}
				>
					Visit Trust Portal
				</Button>
			</div>
			<div className="grid grid-cols-1 gap-5 mt-5 md:grid-cols-3">
				{certifications.map(({ label, description, badge }) => (
					<div key={label} className="flex gap-3 items-start">
						<svg
							viewBox="0 0 44 44"
							fill="none"
							aria-hidden="true"
							className="size-10 shrink-0 text-gray-9"
						>
							<circle cx="22" cy="22" r="21" stroke="currentColor" />
							<circle
								cx="22"
								cy="22"
								r="17.5"
								stroke="currentColor"
								strokeDasharray="1 2.5"
							/>
							{badge}
						</svg>
						<div className="flex flex-col gap-0.5">
							<span className="text-sm font-medium text-gray-12">{label}</span>
							<span className="text-xs leading-5 text-gray-10">
								{description}
							</span>
						</div>
					</div>
				))}
			</div>
			<p className="mt-5 text-xs text-gray-10">
				Request our SOC 2 report, view certifications, and see the full
				subprocessor list at{" "}
				<a
					href={TRUST_PORTAL_URL}
					target="_blank"
					rel="noopener noreferrer"
					className="underline text-gray-12 hover:text-gray-11"
				>
					trust.cap.so
				</a>
				.
			</p>
		</Card>
	);
}
