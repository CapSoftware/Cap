"use client";

import { Card, CardHeader, CardTitle } from "@cap/ui";
import { EnvironmentBadge } from "../_components/EnvironmentBadge";
import { StatBox } from "../_components/StatBox";
import { useDevelopersContext } from "../DevelopersContext";

export function UsageClient() {
	const { apps } = useDevelopersContext();

	const totalVideos = apps.reduce((sum, app) => sum + app.videoCount, 0);
	const totalBalance = apps.reduce(
		(sum, app) => sum + (app.creditAccount?.balanceMicroCredits ?? 0),
		0,
	);

	return (
		<div className="flex flex-col gap-5">
			<h2 className="text-base font-medium text-gray-12">Usage Overview</h2>

			<div className="grid gap-3 sm:grid-cols-3">
				<StatBox label="Total Videos" value={totalVideos} />
				<StatBox label="Total Apps" value={apps.length} />
				<StatBox
					label="Credit Balance"
					value={`$${(totalBalance / 100_000).toFixed(2)}`}
				/>
			</div>

			{apps.length > 0 && (
				<Card>
					<CardHeader>
						<CardTitle>Usage by App</CardTitle>
					</CardHeader>
					<div className="overflow-x-auto rounded-lg border border-gray-3 mt-4">
						<table className="w-full text-sm">
							<thead>
								<tr className="border-b border-gray-3 bg-gray-3/50">
									<th className="px-4 py-2.5 text-left text-xs font-medium text-gray-10">
										App
									</th>
									<th className="px-4 py-2.5 text-left text-xs font-medium text-gray-10">
										Environment
									</th>
									<th className="px-4 py-2.5 text-right text-xs font-medium text-gray-10">
										Videos
									</th>
									<th className="px-4 py-2.5 text-right text-xs font-medium text-gray-10">
										Balance
									</th>
								</tr>
							</thead>
							<tbody>
								{apps.map((app) => (
									<tr
										key={app.id}
										className="border-b border-gray-3 last:border-0"
									>
										<td className="px-4 py-2.5 text-gray-12">{app.name}</td>
										<td className="px-4 py-2.5">
											<EnvironmentBadge environment={app.environment} />
										</td>
										<td className="px-4 py-2.5 text-right text-gray-11 tabular-nums">
											{app.videoCount}
										</td>
										<td className="px-4 py-2.5 text-right text-gray-11 tabular-nums">
											$
											{(
												(app.creditAccount?.balanceMicroCredits ?? 0) / 100_000
											).toFixed(2)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</Card>
			)}
		</div>
	);
}
