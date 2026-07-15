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
			toast.success("自定义域名已移除");
			router.refresh();
			setConfirmOpen(false);
		},
		onError: () => {
			toast.error("移除域名失败");
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
				title="移除自定义域名"
				icon={<FontAwesomeIcon icon={faGlobe} />}
				description={`确定要移除此自定义域名吗：${orgCustomDomain}？`}
				onConfirm={handleRemoveDomain}
				confirmLabel={removeDomainMutation.isPending ? "正在移除…" : "移除"}
				cancelLabel="取消"
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
							<h1 className="text-sm font-medium text-gray-12">自定义域名</h1>
							<p className="w-full text-sm text-gray-10">
								为组织的共享录制设置自定义域名。
							</p>
						</div>
					</div>
					<div className="flex flex-1 gap-2 justify-between items-center w-full">
						<div className="flex gap-2 justify-between items-center px-3 flex-1 h-[44px] rounded-xl border bg-gray-2 border-gray-3">
							<p className="text-[13px] text-gray-8">
								{orgCustomDomain || "尚未设置自定义域名"}
							</p>
							<div className="flex items-center">
								{orgCustomDomain && isVerified ? (
									<Tooltip content="已验证">
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
										<Tooltip content="设置尚未完成">
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
									<Tooltip content="移除自定义域名">
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
								设置
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
