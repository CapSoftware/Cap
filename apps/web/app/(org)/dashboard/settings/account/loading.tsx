"use client";

import { SkeletonPage } from "@inflight/ui";

export default function Loading() {
	return (
		<SkeletonPage
			customSkeleton={(Skeleton) => (
				<form>
					<div className="grid gap-6 w-full md:grid-cols-2">
						{/* Profile image card */}
						<div className="flex flex-col p-5 space-y-4 rounded-2xl border bg-gray-3 border-gray-4">
							<div className="space-y-1">
								<Skeleton
									baseColor="var(--gray-4)"
									highlightColor="var(--gray-5)"
									className="w-32 h-7"
								/>{" "}
								{/* Card title */}
								<Skeleton
									baseColor="var(--gray-4)"
									highlightColor="var(--gray-5)"
									count={1}
									className="mt-1 h-4"
								/>{" "}
								{/* Card description */}
							</div>
							<div className="flex-1 rounded-xl border border-dashed bg-gray-2 border-gray-4">
								<div className="flex gap-5 p-5 h-full">
									<div className="flex justify-center items-center rounded-full border border-dashed size-14 bg-gray-3 border-gray-6">
										<Skeleton
											baseColor="var(--gray-5)"
											highlightColor="var(--gray-6)"
											className="size-4"
										/>{" "}
										{/* Icon placeholder */}
									</div>
									<div className="flex-1 space-y-3">
										<Skeleton
											baseColor="var(--gray-4)"
											highlightColor="var(--gray-5)"
											className="w-full h-3 max-w-20"
										/>
										<Skeleton
											baseColor="var(--gray-4)"
											highlightColor="var(--gray-5)"
											className="w-full h-3 max-w-[120px]"
										/>
									</div>
								</div>
							</div>
						</div>

						{/* Your name card */}
						<div className="p-5 space-y-4 rounded-2xl border bg-gray-3 border-gray-4">
							<div className="space-y-1">
								<Skeleton
									baseColor="var(--gray-4)"
									highlightColor="var(--gray-5)"
									className="w-24 h-7"
								/>{" "}
								{/* Card title */}
								<Skeleton
									baseColor="var(--gray-4)"
									highlightColor="var(--gray-5)"
									count={2}
									className="mt-1 h-4"
								/>{" "}
								{/* Card description */}
							</div>
							<div className="flex flex-col flex-wrap gap-3 w-full">
								<Skeleton
									baseColor="var(--gray-4)"
									highlightColor="var(--gray-5)"
									className="w-full h-12 rounded-xl"
								/>{" "}
								{/* First name input */}
								<Skeleton
									baseColor="var(--gray-4)"
									highlightColor="var(--gray-5)"
									className="w-full h-12 rounded-xl"
								/>{" "}
								{/* Last name input */}
							</div>
						</div>

						{/* Contact email card */}
						<div className="flex flex-col gap-4 p-5 rounded-2xl border bg-gray-3 border-gray-4">
							<div className="space-y-1">
								<Skeleton
									baseColor="var(--gray-4)"
									highlightColor="var(--gray-5)"
									className="w-44 h-7"
								/>{" "}
								{/* Card title */}
								<Skeleton
									baseColor="var(--gray-4)"
									highlightColor="var(--gray-5)"
									count={1}
									className="mt-1 h-4"
								/>{" "}
								{/* Card description */}
							</div>
							<Skeleton
								baseColor="var(--gray-4)"
								highlightColor="var(--gray-5)"
								className="w-full h-12 rounded-xl"
							/>{" "}
							{/* Email input */}
						</div>

						{/* Default organization card */}
						<div className="flex flex-col gap-4 p-5 rounded-2xl border bg-gray-3 border-gray-4">
							<div className="space-y-1">
								<Skeleton
									baseColor="var(--gray-4)"
									highlightColor="var(--gray-5)"
									className="w-40 h-7"
								/>{" "}
								{/* Card title */}
								<Skeleton
									baseColor="var(--gray-4)"
									highlightColor="var(--gray-5)"
									count={1}
									className="mt-1 h-4"
								/>{" "}
								{/* Card description */}
							</div>
							<Skeleton
								baseColor="var(--gray-4)"
								highlightColor="var(--gray-5)"
								className="w-full h-12 rounded-xl"
							/>{" "}
							{/* Select dropdown */}
						</div>
					</div>

					{/* Save button */}
					<div className="mt-6 w-24">
						<Skeleton
							baseColor="var(--gray-4)"
							highlightColor="var(--gray-5)"
							className="h-9 rounded-lg"
						/>{" "}
						{/* Button */}
					</div>
				</form>
			)}
		/>
	);
}
