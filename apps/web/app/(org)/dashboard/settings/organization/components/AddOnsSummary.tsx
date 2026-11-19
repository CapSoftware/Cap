"use client";

import { SCIM_PRICE_PER_MONTH, SIGNED_BAA_PRICE_PER_MONTH } from "@cap/utils";
import { useCurrency } from "hooks/useCurrency";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { formatAmount, type SupportedCurrency } from "@/utils/currency";
import {
	AgreementDoodle,
	DirectoryDoodle,
	KeyDoodle,
} from "../_components/doodles";
import {
	SettingsCard,
	SettingsRow,
	SettingsSection,
	StatusChip,
} from "../_components/settings-ui";

export type AddOnStatuses = {
	sso: "active" | "attention" | "none";
	ssoPrices: { currency: SupportedCurrency; unitAmount: number }[];
	directorySync: "active" | "none";
	signedBaa: "active" | "paid" | "processing" | "none";
};

const monthly = (amount: string) => `${amount}/mo`;

export function AddOnsSummary({ statuses }: { statuses?: AddOnStatuses }) {
	const { activeOrganization } = useDashboardContext();
	const { currency } = useCurrency();
	const organizationId = activeOrganization?.organization.id;
	const securityHref = (anchor: string) =>
		`/dashboard/settings/organization/security${
			organizationId
				? `?organizationId=${encodeURIComponent(organizationId)}`
				: ""
		}#${anchor}`;
	const ssoPrice =
		statuses?.ssoPrices.find((price) => price.currency === currency) ??
		statuses?.ssoPrices.find((price) => price.currency === "usd") ??
		statuses?.ssoPrices[0];

	const rows: {
		anchor: string;
		icon: ReactNode;
		title: string;
		description: string;
		price: string | null;
		chip: ReactNode;
		action: string;
	}[] = [
		{
			anchor: "sso",
			icon: <KeyDoodle />,
			title: "SAML SSO",
			description: "Sign in with Okta, Microsoft Entra ID or Google Workspace.",
			price: ssoPrice
				? monthly(formatAmount(ssoPrice.unitAmount / 100, ssoPrice.currency))
				: null,
			chip:
				statuses?.sso === "active" ? (
					<StatusChip tone="positive">Active</StatusChip>
				) : statuses?.sso === "attention" ? (
					<StatusChip tone="warning">Billing needs attention</StatusChip>
				) : null,
			action: statuses?.sso === "none" ? "Add" : "Manage",
		},
		{
			anchor: "directory-sync",
			icon: <DirectoryDoodle />,
			title: "Directory sync (SCIM)",
			description:
				statuses?.sso === "none"
					? "Add and remove members from your directory. Requires SAML SSO."
					: "Add and remove members automatically from your directory.",
			price: monthly(formatAmount(SCIM_PRICE_PER_MONTH, currency)),
			chip:
				statuses?.directorySync === "active" ? (
					<StatusChip tone="positive">Active</StatusChip>
				) : null,
			action: statuses?.directorySync === "active" ? "Manage" : "Add",
		},
		{
			anchor: "signed-baa",
			icon: <AgreementDoodle />,
			title: "Signed BAA",
			description: "A countersigned HIPAA Business Associate Agreement.",
			price: monthly(formatAmount(SIGNED_BAA_PRICE_PER_MONTH, "usd")),
			chip:
				statuses?.signedBaa === "active" ? (
					<StatusChip tone="positive">Active</StatusChip>
				) : statuses?.signedBaa === "paid" ? (
					<StatusChip tone="warning">Awaiting signature</StatusChip>
				) : statuses?.signedBaa === "processing" ? (
					<StatusChip>Processing</StatusChip>
				) : null,
			action:
				statuses?.signedBaa === "active"
					? "Manage"
					: statuses?.signedBaa === "paid"
						? "Sign"
						: "Add",
		},
	];

	return (
		<SettingsSection anchor="add-ons" title="Add-ons">
			<SettingsCard>
				{rows.map((row) => (
					<SettingsRow
						key={row.anchor}
						icon={row.icon}
						title={row.title}
						meta={row.chip}
						description={row.description}
						control={
							<>
								{row.price && (
									<span className="text-[13px] tabular-nums text-gray-11">
										{row.price}
									</span>
								)}
								<Link
									href={securityHref(row.anchor)}
									prefetch={false}
									aria-label={`${statuses ? row.action : "Manage"} ${row.title}`}
									className="inline-flex gap-1 justify-center items-center px-4 h-8 text-xs font-medium rounded-full border transition-colors min-w-[88px] border-gray-4 text-gray-12 hover:border-gray-5 hover:bg-gray-3"
								>
									{statuses ? row.action : "Manage"}
									<ArrowRight className="size-3.5" aria-hidden="true" />
								</Link>
							</>
						}
					/>
				))}
			</SettingsCard>
		</SettingsSection>
	);
}
