"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

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
  const { activeOrganization } = useDashboardContext();
  const [range, setRange] = useState<AnalyticsRange>("7d");
  const orgId = activeOrganization?.organization.id;

  const query = useQuery<{ data: OrgAnalyticsResponse } | null>({
    queryKey: ["dashboard-analytics", orgId, range],
    queryFn: async () => {
      if (!orgId) return null;
      const response = await fetch(
        `/api/dashboard/analytics?orgId=${orgId}&range=${range}`,
        { cache: "no-store" }
      );
      console.log("response", response);
      if (!response.ok) throw new Error("Failed to load analytics");
      return (await response.json()) as { data: OrgAnalyticsResponse };
    },
    enabled: Boolean(orgId),
    staleTime: 60 * 1000,
  });

  const analytics = query.data?.data;

  if (!orgId) {
    return (
      <div className="rounded-xl border border-gray-5 bg-white p-6 text-gray-11">
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
        topCaps: analytics.breakdowns.topCaps,
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
      />
      <OtherStats data={otherStats} isLoading={query.isLoading} />
    </div>
  );
}
