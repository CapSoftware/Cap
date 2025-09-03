import { Button } from "@cap/ui";
import {
	faCheckCircle,
	faExclamationCircle,
	faGlobe,
	faX,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useMutation } from "@tanstack/react-query";
import clsx from "clsx";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { removeOrganizationDomain } from "@/actions/organization/remove-domain";
import { Tooltip } from "@/components/Tooltip";
import { UpgradeModal } from "@/components/UpgradeModal";
import { ConfirmationDialog } from "../../../_components/ConfirmationDialog";
import { useDashboardContext } from "../../../Contexts";
import CustomDomainDialog from "./CustomDomainDialog/CustomDomainDialog";

export function CustomDomain() {
	const router = useRouter();
	const { activeOrganization, isSubscribed } = useDashboardContext();
	const [showUpgradeModal, setShowUpgradeModal] = useState(false);
	const [showCustomDomainDialog, setShowCustomDomainDialog] = useState(false);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [isVerified, setIsVerified] = useState(
		!!activeOrganization?.organization.domainVerified,
	);

	const orgCustomDomain = activeOrganization?.organization.customDomain;

	const removeDomainMutation = useMutation({
		mutationFn: (organizationId: string) =>
			removeOrganizationDomain(organizationId),
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
		if (!isSubscribed) {
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
			<div className="flex flex-col flex-1 gap-3 justify-between w-full md:flex-row md:items-center h-fit">
				<div className="space-y-4 w-full">
					<div
						className={clsx(
							"flex flex-col md:flex-row gap-3 md:items-center",
							(isVerified && orgCustomDomain) ||
								(!isVerified && orgCustomDomain)
								? "mb-3"
								: "mb-0",
						)}
					>
						<div className="flex flex-col gap-1">
							<h1 className="text-sm font-medium text-gray-12">
								Custom Domain
							</h1>
							<p className="w-full text-sm text-gray-10">
								Setup a custom domain for your organization's shared caps.
							</p>
						</div>
					</div>
					<div className="flex flex-1 gap-2 justify-between items-center w-full">
						<div className="flex gap-2 justify-between items-center px-3 flex-1 h-[44px] rounded-xl border bg-gray-2 border-gray-3">
							<p className="text-[13px] text-gray-8">
								{orgCustomDomain || "No custom domain has been setup"}
							</p>
							<div className="flex items-center">
								{orgCustomDomain && isVerified ? (
									<Tooltip content="Verified">
										<div className="flex gap-2 items-center p-2 h-full text-xs rounded-full w-fit text-gray-10">
											<FontAwesomeIcon
												className="text-green-500 size-5"
												icon={faCheckCircle}
											/>
										</div>
									</Tooltip>
								) : (
									orgCustomDomain &&
									!isVerified && (
										<Tooltip content="Setup not complete">
											<div className="flex gap-2 items-center p-2 h-full text-xs rounded-full w-fit text-gray-10">
												<FontAwesomeIcon
													className="text-red-500 size-5"
													icon={faExclamationCircle}
												/>
											</div>
										</Tooltip>
									)
								)}

								{orgCustomDomain && (
									<Tooltip content="Remove custom domain">
										<div
											onClick={(e) => {
												e.preventDefault();
												setConfirmOpen(true);
											}}
											className="flex justify-center items-center text-xs rounded-full border transition-colors duration-200 cursor-pointer hover:bg-gray-8 hover:border-gray-9 size-5 bg-gray-6 border-gray-7"
										>
											<FontAwesomeIcon
												icon={faX}
												className="text-gray-12 size-[10px]"
											/>
										</div>
									</Tooltip>
								)}
							</div>
						</div>

						{!isVerified && (
							<Button
								type="submit"
								size="sm"
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
				</div>
			</div>

			{showUpgradeModal && (
				<UpgradeModal
					open={showUpgradeModal}
					onOpenChange={setShowUpgradeModal}
				/>
			)}
		</>
	);
}
