"use client";

import { SkeletonPage } from "@cap/ui";

export default function Loading() {
	return (
		<SkeletonPage
			customSkeleton={(Skeleton) => (
				<div className="flex flex-col items-center justify-center w-full min-h-[60vh]">
					<div className="flex flex-col items-center max-w-2xl text-center">
						<Skeleton
							baseColor="var(--gray-4)"
							highlightColor="var(--gray-5)"
							className="!w-16 !h-16 !rounded-2xl mb-6"
						/>

						<Skeleton
							baseColor="var(--gray-4)"
							highlightColor="var(--gray-5)"
							className="!h-9 !w-48 !rounded-lg mb-3"
						/>

						<Skeleton
							baseColor="var(--gray-4)"
							highlightColor="var(--gray-5)"
							className="!h-7 !w-96 !rounded-lg mb-8"
						/>

						<div className="flex flex-col items-center w-full max-w-md gap-4">
							<Skeleton
								baseColor="var(--gray-4)"
								highlightColor="var(--gray-5)"
								className="!h-40 !w-full !rounded-xl"
							/>

							<Skeleton
								baseColor="var(--gray-4)"
								highlightColor="var(--gray-5)"
								className="!h-12 !w-full !rounded-full"
							/>
						</div>
					</div>
				</div>
			)}
		/>
	);
}
