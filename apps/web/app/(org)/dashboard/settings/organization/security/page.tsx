import type { Metadata } from "next";
import { ComplianceCard } from "../components/ComplianceCard";

export const metadata: Metadata = {
	title: "Security & Compliance — Cap",
};

export default function OrganizationSecurityPage() {
	return (
		<div className="flex flex-col gap-6">
			<ComplianceCard />
		</div>
	);
}
