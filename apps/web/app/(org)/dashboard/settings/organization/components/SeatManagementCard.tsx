"use client";

import { Button, Card, CardDescription, CardHeader, CardTitle } from "@cap/ui";
import NumberFlow from "@number-flow/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Minus, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { SubscriptionDetails } from "@/actions/organization/get-subscription-details";
import {
	previewSeatChange,
	updateSeatQuantity,
} from "@/actions/organization/update-seat-quantity";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { calculateSeats } from "@/utils/organization";

const DEBOUNCE_MS = 500;

export function SeatManagementCard() {
	const { activeOrganization } = useDashboardContext();
	const router = useRouter();
	const queryClient = useQueryClient();
	const organizationId = activeOrganization?.organization.id;

	const { proSeatsUsed, proSeatsTotal } = calculateSeats(
		activeOrganization || {},
	);

	const [desiredQuantity, setDesiredQuantity] = useState(proSeatsTotal);
	const [debouncedQuantity, setDebouncedQuantity] = useState(proSeatsTotal);
	const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const prevProSeatsTotal = useRef(proSeatsTotal);

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

	const { data: preview, isFetching: previewLoading } = useQuery({
		queryKey: ["seat-preview", organizationId, debouncedQuantity],
		queryFn: () => {
			if (!organizationId) return null;
			return previewSeatChange(organizationId, debouncedQuantity);
		},
		enabled: !!organizationId && debouncedHasChanges,
		staleTime: 30 * 1000,
	});

	const updateMutation = useMutation({
		mutationFn: () => {
			if (!organizationId) throw new Error("No organization");
			return updateSeatQuantity(organizationId, desiredQuantity);
		},
		onSuccess: (result) => {
			toast.success(`Seat quantity updated to ${result.newQuantity}`);
			queryClient.setQueriesData<SubscriptionDetails | null>(
				{ queryKey: ["subscription-details", organizationId] },
				(old) => (old ? { ...old, currentQuantity: result.newQuantity } : old),
			);
			router.refresh();
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : "Failed to update seats",
			);
		},
	});

	const canDecrease = desiredQuantity > Math.max(1, proSeatsUsed);

	return (
		<Card>
			<CardHeader>
				<CardTitle>Pro Seats</CardTitle>
				<CardDescription>
					Manage how many Pro seats are available for your team.
				</CardDescription>
			</CardHeader>
			<div className="flex flex-col gap-5 mt-4">
				<div className="flex items-center gap-3 text-sm text-gray-11">
					<span>
						<span className="font-medium text-gray-12">{proSeatsUsed}</span> of{" "}
						<span className="font-medium text-gray-12">{proSeatsTotal}</span>{" "}
						Pro seats assigned
					</span>
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
							onClick={() => updateDesiredQuantity(desiredQuantity + 1)}
							className="flex justify-center items-center w-8 h-8 rounded-r-md bg-gray-4 hover:bg-gray-5"
						>
							<Plus className="w-4 h-4 text-gray-12" />
						</button>
					</div>

					{hasChanges && (
						<div className="flex items-center gap-3">
							{previewLoading ? (
								<span className="text-sm text-gray-10">Calculating...</span>
							) : preview ? (
								<span className="text-sm text-gray-11">
									Prorated charge: ${(preview.proratedAmount / 100).toFixed(2)}{" "}
									{preview.currency.toUpperCase()}
								</span>
							) : null}
							<Button
								type="button"
								size="sm"
								variant="primary"
								onClick={() => updateMutation.mutate()}
								disabled={updateMutation.isPending || previewLoading}
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
		</Card>
	);
}
