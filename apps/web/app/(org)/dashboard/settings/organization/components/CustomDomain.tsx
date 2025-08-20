import { Button } from "@cap/ui";
import {
	faExclamationCircle,
	faGlobe,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useMutation } from "@tanstack/react-query";
import clsx from "clsx";
import { CheckCircle, XCircle } from "lucide-react";
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
			<div className="flex gap-3 justify-between items-center w-full h-fit">
				<div className="space-y-1">
					<div
						className={clsx(
							"flex gap-3 items-center",
							(isVerified && orgCustomDomain) ||
								(!isVerified && orgCustomDomain)
								? "mb-3"
								: "mb-0",
						)}
					>
						<h1 className="text-sm font-medium text-gray-12">Custom Domain</h1>
						{process.env.NODE_ENV === "development" && (
							<div className="flex gap-2 items-center p-2 text-xs bg-red-900 rounded-full w-fit text-gray-10">
								<FontAwesomeIcon
									className="text-red-200 size-3"
									icon={faExclamationCircle}
								/>
								<p className="text-xs text-white">
									Custom domains are not available in development mode
								</p>
							</div>
						)}
						{isVerified && orgCustomDomain ? (
							<>
								<Tooltip content="Remove custom domain">
									<div
										onClick={() => setConfirmOpen(true)}
										className="flex gap-2 items-center hover:bg-green-800 transition-colors cursor-pointer px-3 py-0.5 bg-green-900 rounded-full w-fit"
									>
										<CheckCircle className="text-green-200 size-2.5" />
										<p className="text-[11px] italic font-medium text-white">
											{orgCustomDomain}
											<span className="ml-1 not-italic text-white/60">
												verified
											</span>
										</p>
									</div>
								</Tooltip>
							</>
						) : orgCustomDomain ? (
							<>
								<Tooltip content="Remove custom domain">
									<div
										onClick={() => setConfirmOpen(true)}
										className="flex gap-2 items-center px-3 py-0.5 cursor-pointer hover:bg-red-800 transition-colors bg-red-900 rounded-full w-fit"
									>
										<XCircle className="text-red-200 size-2.5" />
										<p className="text-[11px] italic font-medium text-white">
											{orgCustomDomain}
											<span className="ml-1 not-italic text-white/60">
												not verified
											</span>
										</p>
									</div>
								</Tooltip>
							</>
						) : null}
					</div>
					<p className="text-sm w-full max-w-[375px] text-gray-10">
						Set up a custom domain for your organization's shared caps and make
						it unique.
					</p>
				</div>
				<Button
					type="submit"
					size="sm"
					className="min-w-fit"
					spinner={isVerified ? removeDomainMutation.isPending : undefined}
					disabled={isVerified ? removeDomainMutation.isPending : undefined}
					variant="dark"
					onClick={async (e) => {
						e.preventDefault();
						if (isVerified) {
							setConfirmOpen(true);
						} else {
							setShowCustomDomainDialog(true);
						}
					}}
				>
					{isVerified ? "Remove" : "Setup"}
				</Button>
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
