"use client";

import { SkeletonPage } from "@cap/ui";

export default function Loading() {
	return (
		<SkeletonPage
			customSkeleton={(Skeleton) => (
				<div className="flex flex-col gap-6">
					<div className="flex flex-col gap-5 p-6 w-full rounded-2xl border min-h-fit bg-gray-3 border-gray-4">
						<div className="space-y-2">
							<Skeleton
								baseColor="var(--gray-4)"
								highlightColor="var(--gray-5)"
								className="h-[24px] w-[120px]"
							/>
							<Skeleton
								baseColor="var(--gray-4)"
								highlightColor="var(--gray-5)"
								className="h-[16px] w-[280px]"
							/>
						</div>
						<Skeleton
							baseColor="var(--gray-4)"
							highlightColor="var(--gray-5)"
							className="h-[72px] w-full rounded-xl"
						/>
					</div>
					<div className="flex flex-col gap-5 p-6 w-full rounded-2xl border min-h-fit bg-gray-3 border-gray-4">
						<div className="space-y-2">
							<Skeleton
								baseColor="var(--gray-4)"
								highlightColor="var(--gray-5)"
								className="h-[24px] w-[100px]"
							/>
							<Skeleton
								baseColor="var(--gray-4)"
								highlightColor="var(--gray-5)"
								className="h-[16px] w-[260px]"
							/>
						</div>
						<div className="flex flex-col gap-3">
							{Array(5)
								.fill(0)
								.map((_, index) => (
									<Skeleton
										key={index.toString()}
										baseColor="var(--gray-4)"
										highlightColor="var(--gray-5)"
										className="h-[40px] w-full rounded-lg"
									/>
								))}
						</div>
					</div>
				</div>
			)}
		/>
	);
}
