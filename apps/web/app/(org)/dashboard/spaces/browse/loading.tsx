"use client";

import { SkeletonPage } from "@cap/ui";

export default function Loading() {
	return (
		<SkeletonPage
			customSkeleton={(Skeleton) => (
				<div className="flex flex-col min-h-screen lg:gap-5">
					{/* Content Area */}
					<div className="flex overflow-auto flex-col flex-1 bg-gray-2 lg:rounded-tl-2xl">
						{/* Header with Create Button and Search */}
						<div className="flex flex-wrap gap-3 justify-between items-start mb-6 w-full">
							<Skeleton
								baseColor="var(--gray-4)"
								highlightColor="var(--gray-5)"
								className="!h-[40px] !w-[130px] !rounded-full"
							/>
							<div className="flex relative w-full max-w-md">
								<Skeleton
									baseColor="var(--gray-4)"
									highlightColor="var(--gray-5)"
									className="!h-[40px] !w-[280px] sm:!w-[448px] !rounded-xl pl-8"
								/>
							</div>
						</div>

						{/* Table Container */}
						<div className="overflow-x-auto rounded-xl border border-gray-3">
							<div className="min-w-full bg-gray-1">
								{/* Table Header */}
								<div className="border-b border-gray-3">
									<div className="flex text-sm text-left text-gray-10">
										<div className="flex-1 px-6 py-3 font-medium">
											<Skeleton
												baseColor="var(--gray-4)"
												highlightColor="var(--gray-5)"
												className="h-[16px] w-[60px]"
											/>
										</div>
										<div className="flex-1 px-6 py-3 font-medium">
											<Skeleton
												baseColor="var(--gray-4)"
												highlightColor="var(--gray-5)"
												className="h-[16px] w-[70px]"
											/>
										</div>
										<div className="flex-1 px-6 py-3 font-medium">
											<Skeleton
												baseColor="var(--gray-4)"
												highlightColor="var(--gray-5)"
												className="h-[16px] w-[60px]"
											/>
										</div>
										<div className="flex-1 px-6 py-3 font-medium">
											<Skeleton
												baseColor="var(--gray-4)"
												highlightColor="var(--gray-5)"
												className="h-[16px] w-[50px]"
											/>
										</div>
										<div className="flex-1 px-6 py-3 font-medium">
											<Skeleton
												baseColor="var(--gray-4)"
												highlightColor="var(--gray-5)"
												className="h-[16px] w-[60px]"
											/>
										</div>
									</div>
								</div>

								{/* Table Rows */}
								<div>
									{Array(8)
										.fill(0)
										.map((_, index) => (
											<div
												key={index}
												className="border-t border-gray-3 hover:bg-gray-2"
											>
												<div className="flex items-center">
													{/* Name Column */}
													<div className="flex flex-1 gap-3 items-center px-6 py-4">
														<Skeleton
															baseColor="var(--gray-4)"
															highlightColor="var(--gray-5)"
															circle
															width={28}
															height={28}
														/>
														<Skeleton
															baseColor="var(--gray-4)"
															highlightColor="var(--gray-5)"
															className="h-[16px] w-[120px]"
														/>
													</div>

													{/* Members Column */}
													<div className="flex-1 px-6 py-4">
														<Skeleton
															baseColor="var(--gray-4)"
															highlightColor="var(--gray-5)"
															className="h-[16px] w-[80px]"
														/>
													</div>

													{/* Videos Column */}
													<div className="flex-1 px-6 py-4">
														<Skeleton
															baseColor="var(--gray-4)"
															highlightColor="var(--gray-5)"
															className="h-[16px] w-[70px]"
														/>
													</div>

													{/* Role Column */}
													<div className="flex-1 px-6 py-4">
														<Skeleton
															baseColor="var(--gray-4)"
															highlightColor="var(--gray-5)"
															className="h-[16px] w-[60px]"
														/>
													</div>

													{/* Actions Column */}
													<div className="flex-1 px-6 py-4">
														<div className="flex gap-2">
															<Skeleton
																baseColor="var(--gray-4)"
																highlightColor="var(--gray-5)"
																className="!h-[32px] !w-[32px] !rounded-md"
															/>
															<Skeleton
																baseColor="var(--gray-4)"
																highlightColor="var(--gray-5)"
																className="!h-[32px] !w-[32px] !rounded-md"
															/>
														</div>
													</div>
												</div>
											</div>
										))}
								</div>
							</div>
						</div>
					</div>
				</div>
			)}
		/>
	);
}
