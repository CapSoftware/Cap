"use client";

import { SkeletonPage } from "@cap/ui";

export default function Loading() {
	return (
		<div className="flex flex-col flex-1 justify-center w-full">
			<SkeletonPage
				customSkeleton={(Skeleton) => (
					<div className="px-5">
						<div className="mx-auto w-full max-w-[560px] min-w-0 flex flex-col items-center">
							<Skeleton
								baseColor="var(--gray-4)"
								highlightColor="var(--gray-5)"
								className="!h-[20px] !w-[280px]"
							/>
							<div className="flex flex-wrap w-full gap-3 justify-center items-center mt-4">
								<Skeleton
									baseColor="var(--gray-4)"
									highlightColor="var(--gray-5)"
									className="!h-[40px] !w-[170px] !rounded-full"
								/>
								<Skeleton
									baseColor="var(--gray-4)"
									highlightColor="var(--gray-5)"
									className="!h-[40px] !w-[170px] !rounded-full"
								/>
							</div>
							<div className="mt-8 w-full rounded-lg border border-gray-4 bg-gray-2 divide-y divide-gray-4">
								{Array(7)
									.fill(0)
									.map((_, index) => (
										<div key={index.toString()} className="p-3">
											<Skeleton
												baseColor="var(--gray-4)"
												highlightColor="var(--gray-5)"
												className="!h-[20px] !w-[220px]"
											/>
										</div>
									))}
							</div>
						</div>
					</div>
				)}
			/>
		</div>
	);
}
