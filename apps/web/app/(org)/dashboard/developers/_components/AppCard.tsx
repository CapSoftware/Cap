"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { DeveloperApp } from "../developer-data";
import { EnvironmentBadge } from "./EnvironmentBadge";

export function AppCard({ app }: { app: DeveloperApp }) {
	return (
		<Link
			href={`/dashboard/developers/apps/${app.id}/settings`}
			className="group flex flex-col gap-4 p-4 rounded-xl border border-gray-3 bg-gray-2 hover:border-gray-6 transition-colors"
		>
			<div className="flex justify-between items-start">
				<div className="flex flex-col gap-1.5">
					<h3 className="text-sm font-medium text-gray-12">{app.name}</h3>
					<EnvironmentBadge environment={app.environment} />
				</div>
				<ArrowRight
					size={16}
					className="text-gray-8 group-hover:text-gray-11 transition-colors mt-0.5"
				/>
			</div>
			<div className="flex gap-4 text-xs text-gray-10">
				<span>{app.videoCount} videos</span>
				<span>
					{app.creditAccount
						? `$${((app.creditAccount.balanceMicroCredits ?? 0) / 100_000).toFixed(2)} credits`
						: "$0.00 credits"}
				</span>
			</div>
		</Link>
	);
}
