"use client";

import { Button, Switch } from "@cap/ui";
import { getProPlanId } from "@cap/utils";
import { faMinus, faPlus } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import NumberFlow from "@number-flow/react";
import { useMutation } from "@tanstack/react-query";
import clsx from "clsx";
import { Effect } from "effect";
import { useRouter } from "next/navigation";
import { startTransition, useId, useState } from "react";
import { toast } from "sonner";
import { useEffectMutation } from "@/lib/EffectRuntime";
import { withRpc } from "@/lib/Rpcs";
import { homepageCopy } from "../../../../data/homepage-copy";
import { Base } from "./Base";

export function InviteTeamPage() {
	const billingCycleId = useId();
	const [users, setUsers] = useState(1);
	const [isAnnually, setIsAnnually] = useState(true);
	const router = useRouter();
	const CAP_PRO_ANNUAL_PRICE_PER_USER = homepageCopy.pricing.pro.pricing.annual;
	const CAP_PRO_MONTHLY_PRICE_PER_USER =
		homepageCopy.pricing.pro.pricing.monthly;

	const currentTotalPrice =
		users *
		(isAnnually
			? CAP_PRO_ANNUAL_PRICE_PER_USER
			: CAP_PRO_MONTHLY_PRICE_PER_USER);
	const billingCycleText = isAnnually
		? "per user, billed annually"
		: "per user, billed monthly";

	const incrementUsers = () => setUsers((n) => n + 1);
	const decrementUsers = () => setUsers((n) => (n > 1 ? n - 1 : 1));

	const inviteTeamMutation = useEffectMutation({
		mutationFn: () =>
			Effect.gen(function* () {
				yield* withRpc((r) =>
					r.UserCompleteOnboardingStep({
						step: "inviteTeam",
						data: undefined,
					}),
				);
			}),
		onSuccess: () => {
			startTransition(() => {
				router.push("/onboarding/download");
				router.refresh();
			});
		},
		onError: () => {
			toast.error("An error occurred, please try again");
		},
	});

	const handleSubmit = async (e: React.MouseEvent<HTMLButtonElement>) => {
		e.preventDefault();
		inviteTeamMutation.mutate();
	};

	const planCheckout = async (e: React.MouseEvent<HTMLButtonElement>) => {
		e.preventDefault();
		try {
			const planId = getProPlanId(isAnnually ? "yearly" : "monthly");
			const response = await fetch(`/api/settings/billing/subscribe`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					priceId: planId,
					quantity: users,
					isOnBoarding: true,
				}),
			});
			if (!response.ok) {
				toast.error("Unable to start checkout. Please try again.");
				return;
			}
			const data = await response.json();
			if (data.subscription === true) {
				toast.success("You are already on the Cap Pro plan");
				return;
			}

			await handleSubmit(e);

			if (data.url) {
				window.location.href = data.url;
			}
		} catch (error) {
			console.error("Plan checkout error:", error);
			toast.error("Something went wrong. Please try again.");
		} finally {
			planCheckoutMutation.mutate(e);
		}
	};

	const planCheckoutMutation = useMutation({
		mutationFn: (e: React.MouseEvent<HTMLButtonElement>) => planCheckout(e),
		onError: (error) => {
			console.error("Plan checkout error:", error);
			toast.error("Something went wrong. Please try again.");
		},
	});

	return (
		<Base
			title="Invite your team"
			descriptionClassName="max-w-[360px]"
			description="Invite members of your team to join your organization and share Caps together"
		>
			<div className="text-center">
				<span className="mr-2 text-3xl tabular-nums text-gray-12">
					$<NumberFlow suffix="/mo" value={currentTotalPrice} />
				</span>
				<span className="text-base tabular-nums text-gray-10">
					{" "}
					{billingCycleText}
				</span>
				{isAnnually ? (
					<p className="text-base text-gray-10">
						or,{" "}
						<NumberFlow
							value={CAP_PRO_MONTHLY_PRICE_PER_USER * users}
							className="text-base tabular-nums text-gray-12"
							format={{
								notation: "compact",
								style: "currency",
								currency: "USD",
							}}
							suffix="/mo"
						/>{" "}
						{users === 1 ? (
							"per user, "
						) : (
							<>
								for{" "}
								<NumberFlow value={users} className="text-base tabular-nums" />{" "}
								users,{" "}
							</>
						)}
						billed monthly
					</p>
				) : (
					<p className="text-base text-gray-10">
						or,{" "}
						<NumberFlow
							value={CAP_PRO_ANNUAL_PRICE_PER_USER * users}
							className="text-base tabular-nums text-gray-12"
							format={{
								notation: "compact",
								style: "currency",
								currency: "USD",
							}}
							suffix="/mo"
						/>{" "}
						{users === 1 ? (
							"per user, "
						) : (
							<>
								for{" "}
								<NumberFlow value={users} className="text-base tabular-nums" />{" "}
								users,{" "}
							</>
						)}
						billed annually
					</p>
				)}
			</div>

			<div className="space-y-3">
				<div className="flex flex-wrap gap-5 justify-center items-center p-5 w-full rounded-xl border bg-gray-3 border-gray-4 xs:gap-3 xs:p-3 xs:rounded-full xs:justify-between">
					<div className="flex gap-2 items-center">
						<p className="text-sm text-gray-12">Per user</p>
						<div className="flex items-center">
							<Button
								onClick={decrementUsers}
								className="p-1 bg-gray-12 hover:bg-gray-11 min-w-fit h-fit"
								aria-label="Decrease user count"
							>
								<FontAwesomeIcon
									icon={faMinus}
									className="text-gray-1 size-2.5"
								/>
							</Button>
							<span className="w-6 font-medium tabular-nums text-center text-gray-12">
								<NumberFlow value={users} />
							</span>
							<Button
								onClick={incrementUsers}
								className="p-1 bg-gray-12 hover:bg-gray-11 min-w-fit h-fit"
								aria-label="Increase user count"
							>
								<FontAwesomeIcon
									icon={faPlus}
									className="text-gray-1 size-2.5"
								/>
							</Button>
						</div>
					</div>
					<div className="flex items-center">
						<span
							className={clsx(
								"text-sm",
								!isAnnually ? "text-gray-12" : "text-gray-10",
							)}
						>
							{homepageCopy.pricing.pro.labels.monthly}
						</span>
						<Switch
							checked={isAnnually}
							onCheckedChange={setIsAnnually}
							aria-label="Billing Cycle"
							className="scale-75"
							id={billingCycleId}
						/>
						<span
							className={clsx(
								"text-sm",
								isAnnually ? "text-gray-12" : "text-gray-10",
							)}
						>
							{homepageCopy.pricing.pro.labels.annually}
						</span>
					</div>
				</div>
				<Button
					className="w-full"
					variant="blue"
					spinner={planCheckoutMutation.isPending}
					disabled={planCheckoutMutation.isPending}
					onClick={(e) => planCheckoutMutation.mutate(e)}
				>
					Get Started
				</Button>
			</div>
			<div className="w-full h-px bg-gray-4" />
			<Button
				variant="dark"
				className="mx-auto w-full"
				onClick={handleSubmit}
				spinner={inviteTeamMutation.isPending}
				disabled={inviteTeamMutation.isPending}
			>
				Skip
			</Button>
		</Base>
	);
}
