import { Button } from "@cap/ui";
import { Organisation } from "@cap/web-domain";
import { faGlobe } from "@fortawesome/free-solid-svg-icons/faGlobe";
import { faX } from "@fortawesome/free-solid-svg-icons/faX";
import { useMutation } from "@tanstack/react-query";
import clsx from "clsx";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { removeOrganizationDomain } from "@/actions/organization/remove-domain";
import { FontAwesomeIcon } from "@/components/FontAwesomeIcon";
import { Tooltip } from "@/components/Tooltip";
import { UpgradeModal } from "@/components/UpgradeModal";
import { ConfirmationDialog } from "../../../_components/ConfirmationDialog";
import { useDashboardContext } from "../../../Contexts";
import { SettingsRow, StatusChip } from "../_components/settings-ui";
import CustomDomainDialog from "./CustomDomainDialog/CustomDomainDialog";

export function CustomDomain() {
	const router = useRouter();
	const { activeOrganization, user } = useDashboardContext();
	const [showUpgradeModal, setShowUpgradeModal] = useState(false);
	const [showCustomDomainDialog, setShowCustomDomainDialog] = useState(false);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [isVerified, setIsVerified] = useState(
		!!activeOrganization?.organization.domainVerified,
	);

	const orgCustomDomain = activeOrganization?.organization.customDomain;

	const removeDomainMutation = useMutation({
		mutationFn: (organizationId: string) =>
			removeOrganizationDomain(
				Organisation.OrganisationId.make(organizationId),
			),
		onSuccess: () => {
			setIsVerified(false);
			toast.success("Custom domain removed");
			router.refresh();
			setConfirmOpen(false);
		},
		onError: () => {
			toast.error("Failed to remove domain");
			setConfirmOpen(false);
		},
	});

	const handleRemoveDomain = () => {
		if (!user.isPro) {
			setShowUpgradeModal(true);
			return;
		}

		if (activeOrganization?.organization.id) {
			removeDomainMutation.mutate(activeOrganization.organization.id);
		}
	};

	return (
		<>
			{showCustomDomainDialog && (
				<CustomDomainDialog
					isVerified={isVerified}
					setIsVerified={setIsVerified}
					open={showCustomDomainDialog}
					setShowUpgradeModal={(arg) => setShowUpgradeModal(arg)}
					onClose={() => setShowCustomDomainDialog(false)}
				/>
			)}
			<ConfirmationDialog
				open={confirmOpen}
				title="Remove custom domain"
				icon={<FontAwesomeIcon icon={faGlobe} />}
				description={`Are you sure you want to remove this custom domain: ${orgCustomDomain}?`}
				onConfirm={handleRemoveDomain}
				confirmLabel={removeDomainMutation.isPending ? "Removing..." : "Remove"}
				cancelLabel="Cancel"
				loading={removeDomainMutation.isPending}
				onCancel={() => setConfirmOpen(false)}
			/>
			<SettingsRow
				title="Custom domain"
				meta={
					orgCustomDomain ? (
						isVerified ? (
							<StatusChip tone="positive">Verified</StatusChip>
						) : (
							<StatusChip tone="warning">Setup not complete</StatusChip>
						)
					) : null
				}
				description="Set up a custom domain for your organization's shared caps."
				control={
					<div className="flex gap-2 items-center w-full sm:w-auto">
						<div className="flex flex-1 gap-2 justify-between items-center pr-1.5 pl-3 h-9 rounded-lg border sm:flex-none sm:w-60 bg-gray-2 border-gray-3">
							<p
								className={clsx(
									"text-[13px] truncate",
									orgCustomDomain ? "text-gray-12" : "text-gray-9",
								)}
							>
								{orgCustomDomain || "No custom domain"}
							</p>
							{orgCustomDomain && (
								<Tooltip content="Remove custom domain">
									<button
										type="button"
										aria-label="Remove custom domain"
										onClick={(e) => {
											e.preventDefault();
											setConfirmOpen(true);
										}}
										className="flex justify-center items-center rounded-md transition-colors shrink-0 size-6 text-gray-10 hover:bg-gray-4 hover:text-gray-12"
									>
										<FontAwesomeIcon icon={faX} className="size-2.5" />
									</button>
								</Tooltip>
							)}
						</div>
						{!isVerified && (
							<Button
								type="submit"
								size="sm"
								className="px-4 h-9 min-w-fit"
								variant="dark"
								onClick={(e) => {
									e.preventDefault();
									setShowCustomDomainDialog(true);
								}}
							>
								Set up
							</Button>
						)}
					</div>
				}
			/>

			{showUpgradeModal && (
				<UpgradeModal
					open={showUpgradeModal}
					onOpenChange={setShowUpgradeModal}
				/>
			)}
		</>
	);
}
