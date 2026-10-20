"use client";

import { SkeletonPage } from "@cap/ui";

const ROWS = ["comments", "replies", "views", "anonViews", "reactions"];

export default function Loading() {
	return (
		<SkeletonPage
			customSkeleton={(Skeleton) => (
				<div className="p-5 rounded-2xl border divide-y bg-gray-3 border-gray-4 divide-gray-4">
					{ROWS.map((row) => (
						<div
							key={row}
							className="flex gap-4 justify-between items-center py-4 first:pt-0 last:pb-0"
						>
							<div className="space-y-2">
								<Skeleton
									baseColor="var(--gray-4)"
									highlightColor="var(--gray-5)"
									className="w-32 h-5"
								/>
								<Skeleton
									baseColor="var(--gray-4)"
									highlightColor="var(--gray-5)"
									className="w-64 h-4 max-w-full"
								/>
							</div>
							<Skeleton
								baseColor="var(--gray-4)"
								highlightColor="var(--gray-5)"
								className="w-11 h-6 rounded-full"
							/>
						</div>
					))}
				</div>
			)}
		/>
	);
}
