"use client";

import { useEffect, useState } from "react";
import { getPaidUsersStatsInRange, getUsersCreatedInRange } from "./actions";
import type { DateRange } from "./dateRangeUtils";
import UserLookup from "./UserLookup";

type Stats = {
	newUsers: number | null;
	paidUsersStats: {
		totalPaidUsers: number;
		usersWhoCreatedVideoFirst: number;
		percentage: number;
	} | null;
};

export default function AdminDashboardClient() {
	const [dateRange, setDateRange] = useState<DateRange>("today");
	const [stats, setStats] = useState<Stats>({
		newUsers: null,
		paidUsersStats: null,
	});
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		const fetchStats = async () => {
			setLoading(true);
			const [newUsers, paidUsersStats] = await Promise.all([
				getUsersCreatedInRange(dateRange),
				getPaidUsersStatsInRange(dateRange),
			]);
			setStats({ newUsers, paidUsersStats });
			setLoading(false);
		};

		fetchStats();
	}, [dateRange]);

	return (
		<div className="max-w-7xl mx-auto p-6">
			<div className="flex items-center justify-between mb-8">
				<h1 className="text-2xl font-medium">Admin Dashboard</h1>
				<select
					value={dateRange}
					onChange={(e) => setDateRange(e.target.value as DateRange)}
					className="px-4 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
				>
					<option value="today">Today</option>
					<option value="yesterday">Yesterday</option>
					<option value="last7days">Last 7 days</option>
					<option value="thisMonth">This month</option>
					<option value="allTime">All time</option>
				</select>
			</div>

			<div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
				<div className="bg-white rounded-lg shadow p-6">
					<h2 className="text-sm font-medium text-gray-600 mb-2">New Users</h2>
					{loading ? (
						<div className="h-9 bg-gray-200 rounded animate-pulse"></div>
					) : (
						<p className="text-3xl font-medium text-gray-900">
							{stats.newUsers || 0}
						</p>
					)}
				</div>

				<div className="bg-white rounded-lg shadow p-6">
					<h2 className="text-sm font-medium text-gray-600 mb-2">
						New Paid Users
					</h2>
					{loading ? (
						<div className="h-9 bg-gray-200 rounded animate-pulse"></div>
					) : (
						<p className="text-3xl font-medium text-gray-900">
							{stats.paidUsersStats?.totalPaidUsers || 0}
						</p>
					)}
				</div>

				<div className="bg-white rounded-lg shadow p-6">
					<h2 className="text-sm font-medium text-gray-600 mb-2">
						Created Video Before Paying
					</h2>
					{loading ? (
						<div>
							<div className="h-9 bg-gray-200 rounded animate-pulse mb-2"></div>
							<div className="h-4 bg-gray-200 rounded animate-pulse w-3/4"></div>
						</div>
					) : (
						<>
							<p className="text-3xl font-medium text-gray-900">
								{stats.paidUsersStats?.percentage || 0}%
							</p>
							<p className="text-xs text-gray-500 mt-1">
								{stats.paidUsersStats?.usersWhoCreatedVideoFirst || 0} of{" "}
								{stats.paidUsersStats?.totalPaidUsers || 0} users
							</p>
						</>
					)}
				</div>
			</div>

			<div className="bg-white rounded-lg shadow p-6">
				<h2 className="text-lg font-medium mb-4">User Lookup</h2>
				<UserLookup />
			</div>
		</div>
	);
}
