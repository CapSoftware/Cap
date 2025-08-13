"use client";

import { useRouter } from "next/navigation";
import {
	type Dispatch,
	type SetStateAction,
	useCallback,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { manageBilling } from "@/actions/organization/manage-billing";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";

import { BillingCard } from "./components/BillingCard";
import CapSettingsCard from "./components/CapSettingsCard";
import { InviteDialog } from "./components/InviteDialog";
import { MembersCard } from "./components/MembersCard";
import { OrganizationDetailsCard } from "./components/OrganizationDetailsCard";
import { SeatsInfoCards } from "./components/SeatsInfoCards";

export const Organization = () => {
	const { activeOrganization, user } = useDashboardContext();
	const router = useRouter();
	const [loading, setLoading] = useState(false);
	const [billingLoading, setBillingLoading] = useState(false);
	const isOwner = user?.id === activeOrganization?.organization.ownerId;
	const [isInviteDialogOpen, setIsInviteDialogOpen] = useState(false);
	const ownerToastShown = useRef(false);

	const showOwnerToast = useCallback(() => {
		if (!ownerToastShown.current) {
			toast.error("Only the owner can make changes");
			ownerToastShown.current = true;
			setTimeout(() => {
				ownerToastShown.current = false;
			}, 3000);
		}
	}, []);

	const handleManageBilling = useCallback(
		async (loadingDispatch: Dispatch<SetStateAction<boolean>>) => {
			if (!isOwner) {
				showOwnerToast();
				return;
			}
			loadingDispatch(true);
			try {
				const url = await manageBilling();
				router.push(url);
			} catch (error) {
				console.error("Error managing billing:", error);
				toast.error("An error occurred while managing billing");
				loadingDispatch(false);
			}
		},
		[isOwner, showOwnerToast, router],
	);

	return (
		<form className="flex flex-col gap-6">
			<SeatsInfoCards />

			<div className="flex flex-col gap-6 justify-center items-stretch xl:flex-row">
				<OrganizationDetailsCard />
				<CapSettingsCard />
			</div>

			<MembersCard
				isOwner={isOwner}
				loading={loading}
				handleManageBilling={() => handleManageBilling(setLoading)}
				showOwnerToast={showOwnerToast}
				setIsInviteDialogOpen={setIsInviteDialogOpen}
			/>

			<BillingCard
				isOwner={isOwner}
				loading={billingLoading}
				handleManageBilling={() => handleManageBilling(setBillingLoading)}
			/>

			<InviteDialog
				isOpen={isInviteDialogOpen}
				setIsOpen={setIsInviteDialogOpen}
				isOwner={isOwner}
				showOwnerToast={showOwnerToast}
				handleManageBilling={() => handleManageBilling(setLoading)}
			/>
		</form>
	);
};
