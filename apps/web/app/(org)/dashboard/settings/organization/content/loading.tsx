"use client";

import { SkeletonPage } from "@cap/ui";

export default function Loading() {
	return (
		<SkeletonPage
			customSkeleton={(Skeleton) => (
				<div className="flex flex-col gap-6">
					<div className="flex flex-col flex-1 gap-5 p-6 w-full rounded-2xl border min-h-fit bg-gray-3 border-gray-4">
						<div className="space-y-2">
							<Skeleton
								baseColor="var(--gray-4)"
								highlightColor="var(--gray-5)"
								className="h-[24px] w-[200px]"
							/>
							<Skeleton
								baseColor="var(--gray-4)"
								highlightColor="var(--gray-5)"
								className="h-[16px] w-[340px]"
							/>
						</div>
						<div className="grid gap-5 lg:grid-cols-2 lg:gap-x-20">
							{["source", "destination"].map((column) => (
								<div key={column} className="min-w-0">
									<Skeleton
										baseColor="var(--gray-4)"
										highlightColor="var(--gray-5)"
										className="h-[16px] w-[140px] mb-3"
									/>
									<Skeleton
										baseColor="var(--gray-4)"
										highlightColor="var(--gray-5)"
										className="h-[44px] w-full rounded-xl"
									/>
									<Skeleton
										baseColor="var(--gray-4)"
										highlightColor="var(--gray-5)"
										className="h-[44px] w-full rounded-xl mt-3"
									/>
									<Skeleton
										baseColor="var(--gray-4)"
										highlightColor="var(--gray-5)"
										className="h-72 w-full rounded-lg mt-2"
									/>
								</div>
							))}
						</div>
					</div>
				</div>
			)}
		/>
	);
}
