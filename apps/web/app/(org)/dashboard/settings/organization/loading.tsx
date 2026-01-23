"use client";

import { SkeletonPage } from "@inflight/ui";

export default function Loading() {
	return (
		<SkeletonPage
			customSkeleton={(Skeleton) => (
				<div className="flex flex-col gap-6">
					{/* Seats stats cards */}
					<div className="flex flex-col gap-6 md:flex-row">
						{/* Seats Remaining card */}
						<div className="flex flex-col flex-1 gap-3 justify-center items-center p-5 rounded-2xl border bg-gray-3 border-gray-4">
							<div className="overflow-hidden w-5 h-5 rounded-full">
								<Skeleton
									baseColor="var(--gray-4)"
									highlightColor="var(--gray-5)"
									width={20}
									height={20}
								/>
							</div>
							<div className="flex items-center">
								<span className="text-sm">
									<Skeleton
										baseColor="var(--gray-4)"
										highlightColor="var(--gray-5)"
										width={100}
									/>
								</span>
								<span className="ml-2 font-medium">
									<Skeleton
										baseColor="var(--gray-4)"
										highlightColor="var(--gray-5)"
										width={20}
									/>
								</span>
							</div>
						</div>

						{/* Seats Capacity card */}
						<div className="flex flex-col flex-1 gap-3 justify-center items-center p-5 rounded-2xl border bg-gray-3 border-gray-4">
							<div className="overflow-hidden w-5 h-5 rounded-full">
								<Skeleton
									baseColor="var(--gray-4)"
									highlightColor="var(--gray-5)"
									width={20}
									height={20}
								/>
							</div>
							<div className="flex items-center">
								<span className="text-sm">
									<Skeleton
										baseColor="var(--gray-4)"
										highlightColor="var(--gray-5)"
										width={100}
									/>
								</span>
								<span className="ml-2 font-medium">
									<Skeleton
										baseColor="var(--gray-4)"
										highlightColor="var(--gray-5)"
										width={20}
									/>
								</span>
							</div>
						</div>
					</div>

					{/* Organization details wrapper (matches Organization.tsx) */}
					<div className="flex flex-col gap-6 justify-center items-stretch xl:flex-row">
						{/* Organization Details Card */}
						<div className="flex flex-col flex-1 gap-6 p-6 w-full rounded-2xl border min-h-fit bg-gray-3 border-gray-4">
							{/* Card Header */}
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

							{/* Two-column settings grid */}
							<div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
								{/* Left column: Name */}
								<div className="space-y-3">
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
									<div className="flex gap-3 items-center">
										<Skeleton
											className="h-[44px] w-full rounded-xl"
											baseColor="var(--gray-4)"
											highlightColor="var(--gray-5)"
										/>
										<Skeleton
											className="h-[40px] w-[70px] rounded-full"
											baseColor="var(--gray-4)"
											highlightColor="var(--gray-5)"
										/>
									</div>
								</div>

								{/* Right column: Custom Domain */}
								<div className="space-y-3">
									<div className="space-y-1">
										<Skeleton
											className="h-[16px] w-[140px]"
											baseColor="var(--gray-4)"
											highlightColor="var(--gray-5)"
										/>
										<Skeleton
											className="h-[14px] w-[300px]"
											baseColor="var(--gray-4)"
											highlightColor="var(--gray-5)"
										/>
									</div>
									<div className="flex gap-3 items-center">
										<Skeleton
											className="h-[44px] w-full rounded-xl"
											baseColor="var(--gray-4)"
											highlightColor="var(--gray-5)"
										/>
										<Skeleton
											className="h-[40px] w-[80px] rounded-full"
											baseColor="var(--gray-4)"
											highlightColor="var(--gray-5)"
										/>
									</div>
								</div>

								{/* Left column: Access email domain */}
								<div className="space-y-3">
									<div className="space-y-1">
										<Skeleton
											className="h-[16px] w-[160px]"
											baseColor="var(--gray-4)"
											highlightColor="var(--gray-5)"
										/>
										<Skeleton
											className="h-[14px] w-[360px]"
											baseColor="var(--gray-4)"
											highlightColor="var(--gray-5)"
										/>
									</div>
									<div className="flex gap-3 items-center">
										<Skeleton
											className="h-[44px] w-full rounded-xl"
											baseColor="var(--gray-4)"
											highlightColor="var(--gray-5)"
										/>
										<Skeleton
											className="h-[40px] w-[70px] rounded-full"
											baseColor="var(--gray-4)"
											highlightColor="var(--gray-5)"
										/>
									</div>
								</div>

								{/* Right column: Organization Icon */}
								<div className="space-y-3">
									<div className="space-y-1">
										<Skeleton
											className="h-[16px] w-[150px]"
											baseColor="var(--gray-4)"
											highlightColor="var(--gray-5)"
										/>
										<Skeleton
											className="h-[14px] w-[320px]"
											baseColor="var(--gray-4)"
											highlightColor="var(--gray-5)"
										/>
									</div>
									<div className="flex justify-between items-center p-3 rounded-xl border border-dashed border-gray-5">
										<div className="flex gap-2 items-center">
											<Skeleton
												className="h-[28px] w-[110px] rounded-full"
												baseColor="var(--gray-4)"
												highlightColor="var(--gray-5)"
											/>
										</div>
										<Skeleton
											className="h-[28px] w-[28px] rounded-md"
											baseColor="var(--gray-4)"
											highlightColor="var(--gray-5)"
										/>
									</div>
								</div>
							</div>
						</div>
					</div>

					{/* Members Card */}
					<div className="p-6 rounded-2xl border bg-gray-3 border-gray-4">
						{/* Card Header */}
						<div className="flex justify-between items-start mb-6">
							<div className="space-y-2">
								<Skeleton
									baseColor="var(--gray-4)"
									highlightColor="var(--gray-5)"
									className="h-[24px] w-[80px]"
								/>
								<Skeleton
									baseColor="var(--gray-4)"
									highlightColor="var(--gray-5)"
									className="h-[16px] w-[200px]"
								/>
							</div>
							<div className="flex flex-wrap gap-2">
								<Skeleton
									baseColor="var(--gray-4)"
									highlightColor="var(--gray-5)"
									className="!h-[40px] !w-[150px] !rounded-full"
								/>
								<Skeleton
									baseColor="var(--gray-4)"
									highlightColor="var(--gray-5)"
									className="!h-[40px] !w-[120px] !rounded-full"
								/>
							</div>
						</div>

						{/* Members List */}
						<div className="space-y-4">
							{Array(3)
								.fill(0)
								.map((_, index) => (
									<div
										key={index.toString()}
										className="flex justify-between items-center p-4 rounded-xl border border-gray-4"
									>
										<div className="flex gap-3 items-center">
											<Skeleton
												baseColor="var(--gray-4)"
												highlightColor="var(--gray-5)"
												circle
												width={40}
												height={40}
											/>
											<div className="space-y-1">
												<Skeleton
													baseColor="var(--gray-4)"
													highlightColor="var(--gray-5)"
													className="h-[16px] w-[120px]"
												/>
												<Skeleton
													baseColor="var(--gray-4)"
													highlightColor="var(--gray-5)"
													className="h-[14px] w-[160px]"
												/>
											</div>
										</div>
										<div className="flex gap-2 items-center">
											<Skeleton
												baseColor="var(--gray-4)"
												highlightColor="var(--gray-5)"
												className="!h-[32px] !w-[80px] !rounded-full"
											/>
											<Skeleton
												baseColor="var(--gray-4)"
												highlightColor="var(--gray-5)"
												className="!h-[32px] !w-[32px] !rounded-md"
											/>
										</div>
									</div>
								))}
						</div>
					</div>

					{/* Billing Card */}
					<div className="p-6 rounded-2xl border bg-gray-3 border-gray-4">
						{/* Card Header */}
						<div className="flex justify-between items-start mb-6">
							<div className="space-y-2">
								<Skeleton
									baseColor="var(--gray-4)"
									highlightColor="var(--gray-5)"
									className="h-[24px] w-[80px]"
								/>
								<Skeleton
									baseColor="var(--gray-4)"
									highlightColor="var(--gray-5)"
									className="h-[16px] w-[180px]"
								/>
							</div>
							<Skeleton
								baseColor="var(--gray-4)"
								highlightColor="var(--gray-5)"
								className="!h-[40px] !w-[140px] !rounded-full"
							/>
						</div>

						{/* Billing Info */}
						<div className="space-y-4">
							<div className="flex justify-between items-center p-4 rounded-xl border border-gray-4">
								<div className="space-y-1">
									<Skeleton
										baseColor="var(--gray-4)"
										highlightColor="var(--gray-5)"
										className="h-[16px] w-[100px]"
									/>
									<Skeleton
										baseColor="var(--gray-4)"
										highlightColor="var(--gray-5)"
										className="h-[14px] w-[140px]"
									/>
								</div>
								<Skeleton
									baseColor="var(--gray-4)"
									highlightColor="var(--gray-5)"
									className="h-[20px] w-[60px]"
								/>
							</div>
						</div>
					</div>
				</div>
			)}
		/>
	);
}
