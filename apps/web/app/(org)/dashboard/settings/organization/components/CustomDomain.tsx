import { Button } from "@cap/ui";
import { Organisation } from "@cap/web-domain";
import {
	faCheckCircle,
	faExclamationCircle,
	faGlobe,
	faX,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { removeOrganizationDomain } from "@/actions/organization/remove-domain";
import { Tooltip } from "@/components/Tooltip";
import { UpgradeModal } from "@/components/UpgradeModal";
import { ConfirmationDialog } from "../../../_components/ConfirmationDialog";
import { useDashboardContext } from "../../../Contexts";
import CustomDomainDialog from "./CustomDomainDialog/CustomDomainDialog";
import { SettingRow } from "./SettingsRows";

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
			<SettingRow
				label="Custom domain"
				description="Setup a custom domain for your organization's shared caps."
				control={
					<div className="flex gap-2 items-center">
						{orgCustomDomain && (
							<div className="flex gap-2 items-center px-3 h-8 rounded-full border shadow-xs bg-gray-1 border-gray-4">
								<p className="text-[13px] whitespace-nowrap text-gray-12">
									{orgCustomDomain}
								</p>
								{isVerified ? (
									<Tooltip content="Verified">
										<div className="flex items-center text-gray-10">
											<FontAwesomeIcon
												className="text-green-500 size-3.5"
												icon={faCheckCircle}
											/>
										</div>
									</Tooltip>
								) : (
									<Tooltip content="Setup not complete">
										<div className="flex items-center text-gray-10">
											<FontAwesomeIcon
												className="text-red-500 size-3.5"
												icon={faExclamationCircle}
											/>
										</div>
									</Tooltip>
								)}
								<Tooltip content="Remove custom domain">
									<div
										onClick={(e) => {
											e.preventDefault();
											setConfirmOpen(true);
										}}
										className="flex justify-center items-center text-xs rounded-full border transition-colors duration-200 cursor-pointer hover:bg-gray-8 hover:border-gray-9 size-4 bg-gray-6 border-gray-7"
									>
										<FontAwesomeIcon
											icon={faX}
											className="text-gray-12 size-[8px]"
										/>
									</div>
								</Tooltip>
							</div>
						)}

						{!isVerified && (
							<Button
								type="submit"
								size="xs"
								className="min-w-fit"
								variant="dark"
								onClick={(e) => {
									e.preventDefault();
									setShowCustomDomainDialog(true);
								}}
							>
								Setup
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
