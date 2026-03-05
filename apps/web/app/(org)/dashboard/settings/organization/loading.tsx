"use client";

import { SkeletonPage } from "@cap/ui";

export default function Loading() {
	return (
		<SkeletonPage
			customSkeleton={(Skeleton) => (
				<div className="flex flex-col gap-6">
					<div className="flex flex-col flex-1 gap-6 p-6 w-full rounded-2xl border min-h-fit bg-gray-3 border-gray-4">
						<div className="space-y-2">
							<Skeleton
								baseColor="var(--gray-4)"
								highlightColor="var(--gray-5)"
								className="h-[24px] w-[100px]"
							/>
							<Skeleton
								baseColor="var(--gray-4)"
								highlightColor="var(--gray-5)"
								className="h-[16px] w-[280px]"
							/>
						</div>
						<div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
							{Array(4)
								.fill(0)
								.map((_, i) => (
									<div key={i.toString()} className="space-y-3">
										<div className="space-y-1">
											<Skeleton
												className="h-[16px] w-[120px]"
												baseColor="var(--gray-4)"
												highlightColor="var(--gray-5)"
											/>
											<Skeleton
												className="h-[14px] w-[260px]"
												baseColor="var(--gray-4)"
												highlightColor="var(--gray-5)"
											/>
										</div>
										<Skeleton
											className="h-[44px] w-full rounded-xl"
											baseColor="var(--gray-4)"
											highlightColor="var(--gray-5)"
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
