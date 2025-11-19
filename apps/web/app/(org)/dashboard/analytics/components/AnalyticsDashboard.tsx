"use client";

import { buildEnv } from "@cap/env";
import { Button, Switch } from "@cap/ui";
import type { Organisation } from "@cap/web-domain";
import NumberFlow from "@number-flow/react";
import { Fit, Layout, useRive } from "@rive-app/react-canvas";
import { useMutation } from "@tanstack/react-query";
import clsx from "clsx";
import { Effect } from "effect";
import { AnimatePresence, motion } from "framer-motion";
import { Minus, Plus } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { memo, useEffect, useState } from "react";
import { toast } from "sonner";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import { useStripeContext } from "@/app/Layout/StripeContext";
import { useEffectQuery } from "@/lib/EffectRuntime";
import { useDashboardContext } from "../../Contexts";
import type { AnalyticsRange, OrgAnalyticsResponse } from "../types";
import Header from "./Header";
import OtherStats from "./OtherStats";
import StatsChart from "./StatsChart";

const RANGE_OPTIONS: { value: AnalyticsRange; label: string }[] = [
	{ value: "24h", label: "Last 24 hours" },
	{ value: "7d", label: "Last 7 days" },
	{ value: "30d", label: "Last 30 days" },
	{ value: "lifetime", label: "Lifetime" },
];

const ProRiveArt = memo(() => {
	const { RiveComponent: ProModal } = useRive({
		src: "/rive/main.riv",
		artboard: "cap-pro-modal",
		animations: ["animation"],
		layout: new Layout({
			fit: Fit.Cover,
		}),
		autoplay: true,
	});

	return <ProModal className="w-full h-full" />;
});

export function AnalyticsDashboard() {
	const searchParams = useSearchParams();
	const capId = searchParams.get("capId");
	const user = useCurrentUser();
	const stripeCtx = useStripeContext();
	const { push } = useRouter();
	const { activeOrganization, organizationData, spacesData } =
		useDashboardContext();
	const [range, setRange] = useState<AnalyticsRange>("7d");
	const [selectedOrgId, setSelectedOrgId] =
		useState<Organisation.OrganisationId | null>(null);
	const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null);
	const [isAnnual, setIsAnnual] = useState(true);
	const [proQuantity, setProQuantity] = useState(1);

	const showOverlay = buildEnv.NEXT_PUBLIC_IS_CAP === "true" && !user?.isPro;
	const pricePerUser = isAnnual ? 8.16 : 12;
	const totalPrice = pricePerUser * proQuantity;
	const billingText = isAnnual ? "billed annually" : "billed monthly";

	const proCheckoutMutation = useMutation({
		mutationFn: async () => {
			const planId = stripeCtx.plans[isAnnual ? "yearly" : "monthly"];

			const response = await fetch(`/api/settings/billing/subscribe`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					priceId: planId,
					quantity: proQuantity,
					isOnBoarding: false,
				}),
			});
			const data = await response.json();

			if (data.auth === false) {
				localStorage.setItem("pendingPriceId", planId);
				localStorage.setItem("pendingQuantity", proQuantity.toString());
				push(`/login?next=/dashboard/analytics`);
				return;
			}

			if (data.subscription === true) {
				toast.success("You are already on the Cap Pro plan");
				return;
			}

			if (data.url) {
				window.location.href = data.url;
			}
		},
	});

	useEffect(() => {
		if (activeOrganization?.organization.id && !selectedOrgId) {
			setSelectedOrgId(activeOrganization.organization.id);
		}
	}, [activeOrganization, selectedOrgId]);

	const orgId = selectedOrgId || activeOrganization?.organization.id;

	const query = useEffectQuery({
		queryKey: ["dashboard-analytics", orgId, selectedSpaceId, range, capId],
		queryFn: () =>
			Effect.gen(function* () {
				if (!orgId) return null;
				const url = new URL("/api/dashboard/analytics", window.location.origin);
				url.searchParams.set("orgId", orgId);
				url.searchParams.set("range", range);
				if (selectedSpaceId) {
					url.searchParams.set("spaceId", selectedSpaceId);
				}
				if (capId) {
					url.searchParams.set("capId", capId);
				}
				const response = yield* Effect.tryPromise({
					try: () => fetch(url.toString(), { cache: "no-store" }),
					catch: (cause: unknown) => cause as Error,
				});
				if (!response.ok) {
					return yield* Effect.fail(new Error("Failed to load analytics"));
				}
				return yield* Effect.tryPromise({
					try: () => response.json() as Promise<{ data: OrgAnalyticsResponse }>,
					catch: (cause: unknown) => cause as Error,
				});
			}),
		enabled: Boolean(orgId),
		staleTime: 60 * 1000,
	});

	const analytics = (query.data as { data: OrgAnalyticsResponse } | undefined)
		?.data;

	if (!orgId) {
		return (
			<div className="rounded-xl border border-gray-5 bg-gray-2 p-6 text-gray-11">
				Select or join an organization to view analytics.
			</div>
		);
	}

	const otherStats = analytics
		? {
				countries: analytics.breakdowns.countries,
				cities: analytics.breakdowns.cities,
				browsers: analytics.breakdowns.browsers,
				operatingSystems: analytics.breakdowns.operatingSystems,
				deviceTypes: analytics.breakdowns.devices,
				topCaps: capId ? null : analytics.breakdowns.topCaps,
			}
		: {
				countries: [],
				cities: [],
				browsers: [],
				operatingSystems: [],
				deviceTypes: [],
				topCaps: [],
			};

	return (
		<div
			className={clsx(
				"relative min-h-screen",
				showOverlay && "overflow-hidden max-h-screen",
			)}
		>
			<div className="space-y-8">
				<Header
					options={RANGE_OPTIONS}
					value={range}
					onChange={setRange}
					isLoading={query.isFetching}
					organizations={organizationData}
					activeOrganization={activeOrganization}
					spacesData={spacesData}
					selectedOrganizationId={selectedOrgId}
					selectedSpaceId={selectedSpaceId}
					onOrganizationChange={setSelectedOrgId}
					onSpaceChange={setSelectedSpaceId}
					hideCapsSelect={!!capId}
					capId={capId}
					capName={analytics?.capName ?? null}
				/>
				<StatsChart
					counts={{
						caps: analytics?.counts.caps ?? 0,
						views: analytics?.counts.views ?? 0,
						comments: analytics?.counts.comments ?? 0,
						reactions: analytics?.counts.reactions ?? 0,
					}}
					data={analytics?.chart ?? []}
					isLoading={query.isLoading}
					capId={capId}
				/>
				<OtherStats data={otherStats} isLoading={query.isLoading} />
			</div>

			<AnimatePresence>
				{showOverlay && (
					<motion.div
						initial={{ opacity: 0 }}
						animate={{ opacity: 1 }}
						exit={{ opacity: 0 }}
						transition={{ duration: 0.3 }}
						className="absolute inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-[4px] max-h-screen overflow-hidden"
					>
						<motion.div
							initial={{ scale: 0.95, y: -10 }}
							animate={{ scale: 1, y: -20 }}
							exit={{ scale: 0.95, y: -10 }}
							transition={{
								type: "spring",
								duration: 0.4,
								damping: 25,
								stiffness: 500,
							}}
							className="flex relative flex-col w-full max-w-[600px] mx-auto bg-gray-2 bg-opacity-75 backdrop-blur-md border border-gray-4 rounded-xl overflow-hidden shadow-2xl"
						>
							<div className="flex relative flex-col flex-1 justify-between items-end self-stretch">
								<div className="h-[150px] border-b border-gray-4 w-full overflow-hidden">
									<ProRiveArt />
								</div>
								<div className="flex relative flex-col flex-1 justify-center items-center py-6 w-full bg-gray-2 bg-opacity-75 backdrop-blur-md">
									<div className="flex flex-col items-center">
										<h1 className="text-3xl font-medium text-gray-12">
											Upgrade to unlock Cap Analytics
										</h1>
									</div>
									<p className="mt-1 text-lg text-center text-gray-11">
										You can cancel anytime. Early adopter pricing locked in.
									</p>

									<div className="flex flex-col items-center mt-3 mb-4 w-full">
										<div className="flex flex-col items-center mb-1 sm:items-end sm:flex-row">
											<NumberFlow
												value={totalPrice}
												className="text-3xl font-medium tabular-nums text-gray-12"
												format={{
													style: "currency",
													currency: "USD",
												}}
											/>
											<span className="mb-2 ml-2 text-gray-11">
												{proQuantity === 1 ? (
													`per user, ${billingText}`
												) : (
													<>
														for{" "}
														<NumberFlow
															value={proQuantity}
															className="tabular-nums text-gray-12"
														/>{" "}
														users, {billingText}
													</>
												)}
											</span>
										</div>

										<div className="flex flex-col gap-6 justify-evenly items-center mt-8 w-full max-w-md sm:gap-10 sm:flex-row">
											<div className="flex gap-3 items-center">
												<span className="text-gray-12">Annual billing</span>
												<Switch
													checked={isAnnual}
													onCheckedChange={() => setIsAnnual(!isAnnual)}
												/>
											</div>

											<div className="flex items-center">
												<span className="mr-3 text-gray-12">Users:</span>
												<div className="flex items-center">
													<button
														type="button"
														onClick={() =>
															proQuantity > 1 && setProQuantity(proQuantity - 1)
														}
														className="flex justify-center items-center w-8 h-8 rounded-l-md bg-gray-4 hover:bg-gray-5"
														disabled={proQuantity <= 1}
													>
														<Minus className="w-4 h-4 text-gray-12" />
													</button>
													<NumberFlow
														value={proQuantity}
														className="mx-auto w-6 text-sm tabular-nums text-center text-gray-12"
													/>
													<button
														type="button"
														onClick={() => setProQuantity(proQuantity + 1)}
														className="flex justify-center items-center w-8 h-8 rounded-r-md bg-gray-4 hover:bg-gray-5"
													>
														<Plus className="w-4 h-4 text-gray-12" />
													</button>
												</div>
											</div>
										</div>
									</div>

									<Button
										variant="blue"
										type="button"
										onClick={(e) => {
											e.preventDefault();
											proCheckoutMutation.mutate();
										}}
										className="mt-5 w-full max-w-sm h-14 text-lg"
										disabled={proCheckoutMutation.isPending}
									>
										{proCheckoutMutation.isPending
											? "Loading..."
											: "Upgrade to Cap Pro"}
									</Button>
								</div>
							</div>
						</motion.div>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}
