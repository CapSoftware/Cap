"use client";

import { SkeletonPage } from "@inflight/ui";

export default function Loading() {
	return (
		<SkeletonPage
			customSkeleton={(Skeleton) => (
				<div className="flex flex-col min-h-screen lg:gap-5">
					{/* Content Area */}
					<div className="flex overflow-auto flex-col flex-1 bg-gray-2 lg:rounded-tl-2xl">
						{/* Buttons */}
						<div className="flex gap-5 items-center mb-10 w-full">
							<Skeleton
								baseColor="var(--gray-4)"
								highlightColor="var(--gray-5)"
								className="!h-[40px] !w-[130px] !rounded-full"
							/>
							<Skeleton
								baseColor="var(--gray-4)"
								highlightColor="var(--gray-5)"
								className="!h-[40px] !w-[130px] !rounded-full"
							/>
						</div>
						<div className="grid grid-cols-1 gap-4 mb-10 sm:grid-cols-3 md:grid-cols-5">
							{Array(5)
								.fill(0)
								.map((_, index) => (
									<Skeleton
										key={index.toString()}
										baseColor="var(--gray-4)"
										highlightColor="var(--gray-5)"
										className="!h-[72px] w-full !rounded-xl"
									/>
								))}
						</div>
						<div className="flex flex-col w-full">
							<div className="grid grid-cols-1 gap-4 sm:gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
								{Array(15)
									.fill(0)
									.map((_, index) => (
										<div
											key={index.toString()}
											className="flex relative flex-col gap-4 w-full h-full bg-gray-3 rounded-2xl border-gray-4 border-[1px]"
										>
											{/* Thumbnail */}
											<Skeleton
												baseColor="var(--gray-4)"
												highlightColor="var(--gray-5)"
												className="h-[150px] w-full aspect-video align-top !rounded-t-2xl !leading-none !rounded-b-none"
											/>
											<div className="px-4 pb-4">
												{/* Title */}
												<div className="flex flex-col gap-1">
													<Skeleton
														baseColor="var(--gray-4)"
														highlightColor="var(--gray-5)"
														className="h-[20px] w-full max-w-[180px]"
													/>
													<Skeleton
														baseColor="var(--gray-4)"
														highlightColor="var(--gray-5)"
														className="h-[16px] w-[80px]"
													/>
												</div>

												{/* Analytics */}
												<div className="flex flex-wrap gap-3 items-center mt-auto text-sm">
													{/* Views */}
													<div className="flex gap-1 items-center">
														<Skeleton
															baseColor="var(--gray-4)"
															highlightColor="var(--gray-5)"
															circle
															width={16}
															height={16}
														/>
														<Skeleton
															baseColor="var(--gray-4)"
															highlightColor="var(--gray-5)"
															width={20}
															height={16}
														/>
													</div>

													{/* Comments */}
													<div className="flex gap-1 items-center">
														<Skeleton
															baseColor="var(--gray-4)"
															highlightColor="var(--gray-5)"
															circle
															width={16}
															height={16}
														/>
														<Skeleton
															baseColor="var(--gray-4)"
															highlightColor="var(--gray-5)"
															width={20}
															height={16}
														/>
													</div>

													{/* Reactions */}
													<div className="flex gap-1 items-center">
														<Skeleton
															baseColor="var(--gray-4)"
															highlightColor="var(--gray-5)"
															circle
															width={16}
															height={16}
														/>
														<Skeleton
															baseColor="var(--gray-4)"
															highlightColor="var(--gray-5)"
															width={20}
															height={16}
														/>
													</div>
												</div>
											</div>
										</div>
									))}
							</div>

							{/* Pagination */}
							<div className="flex justify-center mt-10">
								<Skeleton
									baseColor="var(--gray-4)"
									highlightColor="var(--gray-5)"
									className="h-[36px] w-[300px]"
								/>
							</div>
						</div>
					</div>
				</div>
			)}
		/>
	);
}
