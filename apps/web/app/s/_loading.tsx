"use client";

export default function Loading() {
	return (
		<div className="min-h-screen flex flex-col bg-[#F7F8FA]">
			<div className="flex-1 container mx-auto px-4 py-4">
				{/* ShareHeader placeholder */}
				<div className="flex items-center justify-between">
					<div>
						<div className="flex items-center space-x-3">
							<div className="w-48 h-6 bg-gray-200 rounded animate-pulse"></div>
							<div className="w-8 h-6 bg-gray-200 rounded-lg animate-pulse"></div>
						</div>
						<div className="mt-2 w-20 h-4 bg-gray-200 rounded-lg animate-pulse"></div>
					</div>
				</div>

				<div className="mt-4">
					<div className="flex flex-col lg:flex-row gap-4">
						<div className="flex-1">
							<div className="relative aspect-video new-card-style p-3">
								{/* ShareVideo placeholder */}
								<div className="relative w-full h-full overflow-hidden shadow-lg rounded-lg">
									<div
										className="relative block w-full h-full rounded-lg bg-gray-200 animate-pulse"
										style={{ paddingBottom: "56.25%" }}
									>
										<div className="absolute inset-0 bg-gray-300 animate-pulse"></div>
									</div>
									{/* Video controls placeholder */}
									<div className="absolute bottom-0 w-full bg-gray-800 bg-opacity-50">
										<div className="flex items-center justify-between px-4 py-2">
											<div className="flex items-center space-x-3">
												<div className="w-8 h-8 bg-gray-400 rounded-full animate-pulse"></div>
												<div className="w-24 h-4 bg-gray-400 rounded animate-pulse"></div>
											</div>
											<div className="flex space-x-2">
												<div className="w-8 h-8 bg-gray-400 rounded-full animate-pulse"></div>
												<div className="w-8 h-8 bg-gray-400 rounded-full animate-pulse"></div>
												<div className="w-8 h-8 bg-gray-400 rounded-full animate-pulse"></div>
												<div className="w-8 h-8 bg-gray-400 rounded-full animate-pulse"></div>
											</div>
										</div>
									</div>
								</div>
							</div>
							<div className="mt-4 lg:hidden">
								{/* Mobile Toolbar placeholder */}
								<div className="flex justify-center">
									<div className="w-64 h-10 bg-gray-200 rounded animate-pulse"></div>
								</div>
							</div>
						</div>

						{/* Sidebar placeholder */}
						<div className="lg:w-80 flex flex-col">
							<div className="new-card-style p-4">
								<div className="space-y-4">
									{/* Analytics placeholder */}
									<div className="flex justify-between">
										<div className="w-20 h-6 bg-gray-200 rounded animate-pulse"></div>
										<div className="w-20 h-6 bg-gray-200 rounded animate-pulse"></div>
										<div className="w-20 h-6 bg-gray-200 rounded animate-pulse"></div>
									</div>

									{/* Comments placeholder */}
									<div className="space-y-4">
										{[1, 2, 3].map((i) => (
											<div key={i} className="flex space-x-3">
												<div className="w-8 h-8 bg-gray-200 rounded-full animate-pulse"></div>
												<div className="flex-1 space-y-2">
													<div className="w-32 h-4 bg-gray-200 rounded animate-pulse"></div>
													<div className="w-full h-4 bg-gray-200 rounded animate-pulse"></div>
												</div>
											</div>
										))}
									</div>
								</div>
							</div>
						</div>
					</div>

					<div className="hidden lg:block mt-4">
						{/* Desktop Toolbar placeholder */}
						<div className="flex justify-center">
							<div className="w-64 h-10 bg-gray-200 rounded animate-pulse"></div>
						</div>
					</div>
				</div>
			</div>

			{/* Footer placeholder */}
			<div className="mt-auto py-4">
				<div className="flex items-center justify-center space-x-2 py-2 px-4 bg-gray-1 border border-gray-200 rounded-full mx-auto w-fit">
					<div className="w-20 h-4 bg-gray-200 rounded animate-pulse"></div>
					<div className="w-14 h-6 bg-gray-200 rounded animate-pulse"></div>
				</div>
			</div>
		</div>
	);
}
