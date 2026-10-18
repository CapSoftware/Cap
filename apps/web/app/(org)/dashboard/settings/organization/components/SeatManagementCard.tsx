"use client";

import { Button, Card, CardDescription, CardHeader, CardTitle } from "@cap/ui";
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
		mutationFn: () => {
			if (!organizationId) throw new Error("No organization");
			return updateSeatQuantity(organizationId, desiredQuantity);
		},
		onSuccess: (result) => {
			setCancelDialogOpen(false);
			if (result.cancelAtPeriodEnd) {
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

	return (
		<Card>
			<CardHeader>
				<CardTitle>Pro Seats</CardTitle>
				<CardDescription>
					Manage how many Pro seats are available for your team.
				</CardDescription>
			</CardHeader>
			<div className="flex flex-col gap-5 mt-4">
				<div className="flex flex-col gap-1 text-sm text-gray-11">
					<span>
						<span className="font-medium text-gray-12">{proSeatsUsed}</span> of{" "}
						<span className="font-medium text-gray-12">{proSeatsTotal}</span>{" "}
						Pro seats in use
					</span>
					{activeOrganization?.ownerIsPro && (
						<span className="text-xs text-gray-10">
							The organization owner is always on Cap Pro and uses one of your
							seats.
						</span>
					)}
				</div>

				<div className="flex flex-wrap items-center gap-4">
					<div className="flex items-center gap-1">
						<span className="mr-2 text-sm text-gray-12">Seats:</span>
						<button
							type="button"
							onClick={() =>
								canDecrease && updateDesiredQuantity(desiredQuantity - 1)
							}
							className="flex justify-center items-center w-8 h-8 rounded-l-md bg-gray-4 hover:bg-gray-5 disabled:opacity-50 disabled:cursor-not-allowed"
							disabled={!canDecrease}
						>
							<Minus className="w-4 h-4 text-gray-12" />
						</button>
						<NumberFlow
							value={desiredQuantity}
							className="mx-auto w-8 text-sm tabular-nums text-center text-gray-12"
						/>
						<button
							type="button"
							onClick={() =>
								canIncrease && updateDesiredQuantity(desiredQuantity + 1)
							}
							className="flex justify-center items-center w-8 h-8 rounded-r-md bg-gray-4 hover:bg-gray-5 disabled:opacity-50 disabled:cursor-not-allowed"
							disabled={!canIncrease}
						>
							<Plus className="w-4 h-4 text-gray-12" />
						</button>
					</div>

					{hasChanges && (
						<div className="flex items-center gap-3">
							{debounceInFlight ? (
								<span className="text-sm text-gray-10">Calculating...</span>
							) : isCancelRequest ? (
								<span className="text-sm text-amber-700">
									Cancels Cap Pro at the end of the billing period
								</span>
							) : previewLoading ? (
								<span className="text-sm text-gray-10">Calculating...</span>
							) : previewError ? (
								<span className="text-sm text-red-500">
									Unable to calculate preview
								</span>
							) : preview ? (
								<span className="text-sm text-gray-11">
									{preview.proratedAmount === 0
										? "No prorated adjustment"
										: `${preview.proratedAmount > 0 ? "Due now" : "Prorated credit"}: ${formatAmount(Math.abs(preview.proratedAmount / 100), preview.currency)}`}
								</span>
							) : null}
							<Button
								type="button"
								size="sm"
								variant={isCancelRequest ? "destructive" : "primary"}
								onClick={() => {
									if (isCancelRequest) setCancelDialogOpen(true);
									else updateMutation.mutate();
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
							<Button
								type="button"
								size="sm"
								variant="gray"
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
						</div>
					)}
				</div>
			</div>
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
				onConfirm={() => updateMutation.mutate()}
				onCancel={() => {
					if (!updateMutation.isPending) setCancelDialogOpen(false);
				}}
			/>
		</Card>
	);
}
