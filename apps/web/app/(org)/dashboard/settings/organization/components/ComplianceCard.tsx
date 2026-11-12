import { ArrowUpRight } from "lucide-react";
import { doodleHost, SealDoodle } from "../_components/doodles";
import { SettingsCard, SettingsSection } from "../_components/settings-ui";

const TRUST_PORTAL_URL = "https://trust.cap.so";

const certifications: {
	label: string;
	description: string;
	seal: [string] | [string, string];
}[] = [
	{
		label: "SOC 2 Type II",
		description:
			"Independently audited security, availability, and confidentiality controls, tested continuously over time.",
		seal: ["SOC 2"],
	},
	{
		label: "ISO 27001",
		description:
			"Certified information security management system covering risk, access, incident response, and vendors.",
		seal: ["ISO", "27001"],
	},
	{
		label: "HIPAA",
		description:
			"HIPAA compliance verified through Comp AI, with every vendor in Cap's production infrastructure covered by a BAA.",
		seal: ["HIPAA"],
	},
];

export function ComplianceCard() {
	return (
		<SettingsSection
			title="Compliance"
			action={
				<a
					href={TRUST_PORTAL_URL}
					target="_blank"
					rel="noopener noreferrer"
					className="inline-flex gap-1 items-center text-[13px] font-medium underline-offset-4 text-gray-12 hover:underline"
				>
					Visit Trust Portal
					<ArrowUpRight className="size-3.5" aria-hidden="true" />
				</a>
			}
		>
			<SettingsCard>
				<div className="grid grid-cols-1 md:grid-cols-3">
					{certifications.map(({ label, description, seal }, index) => (
						<div
							key={label}
							className={`flex gap-3.5 items-start px-4 py-5 sm:px-5 ${doodleHost}`}
						>
							<SealDoodle lines={seal} delay={index * 0.15} />
							<div className="flex flex-col gap-0.5">
								<span className="text-sm font-medium text-gray-12">
									{label}
								</span>
								<span className="text-[13px] leading-5 text-gray-10">
									{description}
								</span>
							</div>
						</div>
					))}
				</div>
				<p className="px-4 py-3.5 text-[13px] leading-5 text-gray-10 sm:px-5">
					Cap's compliance program is completed and continuously monitored
					through Comp AI. Request our SOC 2 report, view certifications, and
					see the full subprocessor list at{" "}
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
			</SettingsCard>
		</SettingsSection>
	);
}
