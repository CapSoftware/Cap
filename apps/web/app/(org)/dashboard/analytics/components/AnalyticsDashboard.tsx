"use client";

import type { Organisation } from "@cap/web-domain";
import { Effect } from "effect";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
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
];

const formatNumber = (value: number) =>
	new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);

export function AnalyticsDashboard() {
	const searchParams = useSearchParams();
	const capId = searchParams.get("capId");
	const { activeOrganization, organizationData, spacesData } =
		useDashboardContext();
	const [range, setRange] = useState<AnalyticsRange>("7d");
	const [selectedOrgId, setSelectedOrgId] =
		useState<Organisation.OrganisationId | null>(null);
	const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null);

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
	);
}
