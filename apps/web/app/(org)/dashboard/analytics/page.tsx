"use client";

import { Select } from "@cap/ui";

export default function AnalyticsPage() {
	return (
		<>
			<div className="flex gap-2 items-center">
				<Select
					variant="dark"
					size="fit"
					options={[
						{ value: "views", label: "Views" },
						{ value: "comments", label: "Comments" },
						{ value: "reactions", label: "Reactions" },
					]}
					onValueChange={() => {}}
					placeholder="Metric"
				/>
				<Select
					variant="dark"
					size="fit"
					options={[
						{ value: "24_hours", label: "24 hours" },
						{ value: "7_days", label: "7 days" },
						{ value: "30_days", label: "30 days" },
					]}
					onValueChange={() => {}}
					placeholder="Time range"
				/>
			</div>
		</>
	);
}
