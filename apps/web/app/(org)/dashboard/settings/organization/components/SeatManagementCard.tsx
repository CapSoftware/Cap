"use client";

import { Button } from "@cap/ui";
import NumberFlow from "@number-flow/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Minus, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	getSignedBaaStatus,
	type SignedBaaStatus,
} from "@/actions/organization/signed-baa";
import {
	previewSeatChange,
	updateSeatQuantity,
} from "@/actions/organization/update-seat-quantity";
import { ConfirmationDialog } from "@/app/(org)/dashboard/_components/ConfirmationDialog";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { formatAmount } from "@/utils/currency";
import { calculateSeats } from "@/utils/organization";
import { SeatMeter, SeatsDoodle } from "../_components/doodles";
import { SettingsRow } from "../_components/settings-ui";

const DEBOUNCE_MS = 500;

export function SeatManagementCard() {
	const { activeOrganization } = useDashboardContext();
	const router = useRouter();
	const queryClient = useQueryClient();
	const organizationId = activeOrganization?.organization.id;

	const { proSeatsUsed, proSeatsTotal } = calculateSeats({
		...(activeOrganization || {}),
		ownerId: activeOrganization?.organization.ownerId,
		ownerIsPro: Boolean(activeOrganization?.ownerIsPro),
	});

	const [desiredQuantity, setDesiredQuantity] = useState(proSeatsTotal);
	const [debouncedQuantity, setDebouncedQuantity] = useState(proSeatsTotal);
	const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
	const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const prevProSeatsTotal = useRef(proSeatsTotal);

	const { data: baa } = useQuery<SignedBaaStatus | null>({
		queryKey: ["signed-baa", organizationId],
		queryFn: () => {
			if (!organizationId) return null;
			return getSignedBaaStatus(organizationId);
		},
		enabled: !!organizationId,
		staleTime: 60 * 1000,
	});

	useEffect(() => {
		if (prevProSeatsTotal.current !== proSeatsTotal) {
			setDesiredQuantity(proSeatsTotal);
			setDebouncedQuantity(proSeatsTotal);
			if (debounceTimer.current) {
				clearTimeout(debounceTimer.current);
			}
			prevProSeatsTotal.current = proSeatsTotal;
		}
	}, [proSeatsTotal]);

	useEffect(() => {
		return () => {
			if (debounceTimer.current) {
				clearTimeout(debounceTimer.current);
			}
		};
	}, []);

	const updateDesiredQuantity = (newQuantity: number) => {
		setDesiredQuantity(newQuantity);
		if (debounceTimer.current) {
			clearTimeout(debounceTimer.current);
		}
		debounceTimer.current = setTimeout(() => {
			setDebouncedQuantity(newQuantity);
		}, DEBOUNCE_MS);
	};

	const hasChanges = desiredQuantity !== proSeatsTotal;
	const debouncedHasChanges = debouncedQuantity !== proSeatsTotal;
	const debounceInFlight = desiredQuantity !== debouncedQuantity;

	const {
		data: preview,
		isFetching: previewLoading,
		isError: previewError,
	} = useQuery({
		queryKey: ["seat-preview", organizationId, debouncedQuantity],
		queryFn: () => {
			if (!organizationId) return null;
			return previewSeatChange(organizationId, debouncedQuantity);
		},
		enabled: !!organizationId && debouncedHasChanges && debouncedQuantity >= 1,
		staleTime: 30 * 1000,
	});

	const updateMutation = useMutation({
		mutationFn: (quantity: number) => {
			if (!organizationId) throw new Error("No organization");
			return updateSeatQuantity(organizationId, quantity);
		},
		onSuccess: (result, quantity) => {
			setCancelDialogOpen(false);
			if (quantity === 0) {
				toast.success("Cap Pro will cancel at the end of the billing period");
				setDesiredQuantity(proSeatsTotal);
				setDebouncedQuantity(proSeatsTotal);
			} else {
				toast.success(`Seat quantity updated to ${result.newQuantity}`);
			}
			queryClient.invalidateQueries({
				queryKey: ["subscription-details", organizationId],
			});
			router.refresh();
		},
		onError: (error) => {
			setCancelDialogOpen(false);
			toast.error(
				error instanceof Error ? error.message : "Failed to update seats",
			);
			queryClient.invalidateQueries({
				queryKey: ["subscription-details", organizationId],
			});
			router.refresh();
		},
	});

	const MAX_SEATS = 500;
	// With no member seats assigned (only the owner's), stepping to 0 is
	// allowed and means canceling the subscription entirely.
	const minQuantity = proSeatsUsed > 1 ? proSeatsUsed : 0;
	const canDecrease = desiredQuantity > minQuantity;
	const canIncrease = desiredQuantity < MAX_SEATS;
	const isCancelRequest = desiredQuantity === 0;
	const baaActive = baa?.status === "active" || baa?.status === "paid";

	const stepperButton =
		"flex justify-center items-center rounded-full transition-colors size-7 text-gray-12 hover:bg-gray-4 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent";

	return (
		<>
			<SettingsRow
				anchor="seats"
				icon={<SeatsDoodle />}
				title="Pro seats"
				description={
					<>
						<span className="font-medium tabular-nums text-gray-12">
							{proSeatsUsed} of {proSeatsTotal}
						</span>{" "}
						in use
						{activeOrganization?.ownerIsPro &&
							". The organization owner is always on Cap Pro and uses one of your seats."}
					</>
				}
				control={
					<>
						<span className="hidden mr-2 sm:block">
							<SeatMeter
								used={proSeatsUsed}
								total={Math.max(desiredQuantity, proSeatsUsed)}
							/>
						</span>
						<div className="flex gap-0.5 items-center p-0.5 rounded-full border shadow-xs border-gray-4 bg-gray-1">
							<button
								type="button"
								aria-label="Remove a seat"
								onClick={() =>
									canDecrease && updateDesiredQuantity(desiredQuantity - 1)
								}
								className={stepperButton}
								disabled={!canDecrease}
							>
								<Minus className="size-3.5" />
							</button>
							<NumberFlow
								value={desiredQuantity}
								aria-label="Seats"
								className="w-9 text-sm font-medium tabular-nums text-center text-gray-12"
							/>
							<button
								type="button"
								aria-label="Add a seat"
								onClick={() =>
									canIncrease && updateDesiredQuantity(desiredQuantity + 1)
								}
								className={stepperButton}
								disabled={!canIncrease}
							>
								<Plus className="size-3.5" />
							</button>
						</div>
					</>
				}
			>
				{hasChanges && (
					<div className="flex flex-wrap gap-3 justify-between items-center px-4 py-3 mt-4 rounded-xl bg-gray-2">
						{debounceInFlight ? (
							<span className="text-[13px] text-gray-10">Calculating...</span>
						) : isCancelRequest ? (
							<span className="text-[13px] text-amber-700">
								Cancels Cap Pro at the end of the billing period
							</span>
						) : previewLoading ? (
							<span className="text-[13px] text-gray-10">Calculating...</span>
						) : previewError ? (
							<span className="text-[13px] text-red-500">
								Unable to calculate preview
							</span>
						) : preview ? (
							<span className="text-[13px] text-gray-11">
								{preview.proratedAmount === 0
									? "No prorated adjustment"
									: `${preview.proratedAmount > 0 ? "Due now" : "Prorated credit"}: ${formatAmount(Math.abs(preview.proratedAmount / 100), preview.currency)}`}
							</span>
						) : (
							<span />
						)}
						<div className="flex gap-2 items-center">
							<Button
								type="button"
								size="xs"
								variant="outline"
								className="px-4"
								onClick={() => {
									setDesiredQuantity(proSeatsTotal);
									setDebouncedQuantity(proSeatsTotal);
									if (debounceTimer.current) {
										clearTimeout(debounceTimer.current);
									}
								}}
								disabled={updateMutation.isPending}
							>
								Cancel
							</Button>
							<Button
								type="button"
								size="xs"
								variant={isCancelRequest ? "destructive" : "dark"}
								className="px-4"
								onClick={() => {
									if (isCancelRequest) setCancelDialogOpen(true);
									else updateMutation.mutate(desiredQuantity);
								}}
								disabled={
									updateMutation.isPending ||
									debounceInFlight ||
									(!isCancelRequest && (previewLoading || previewError))
								}
								spinner={updateMutation.isPending}
							>
								{updateMutation.isPending ? "Updating..." : "Confirm"}
							</Button>
						</div>
					</div>
				)}
			</SettingsRow>
			<ConfirmationDialog
				open={cancelDialogOpen}
				title="Cancel Cap Pro?"
				description={`You'll lose your Pro seat and your organization's Pro features at the end of the current billing period.${
					baaActive
						? " Your Signed BAA will also be canceled when the subscription ends."
						: ""
				} You can resume anytime before then by adding seats back.`}
				confirmLabel="Cancel subscription"
				cancelLabel="Keep Cap Pro"
				confirmVariant="destructive"
				loading={updateMutation.isPending}
				onConfirm={() => updateMutation.mutate(desiredQuantity)}
				onCancel={() => {
					if (!updateMutation.isPending) setCancelDialogOpen(false);
				}}
			/>
		</>
	);
}
