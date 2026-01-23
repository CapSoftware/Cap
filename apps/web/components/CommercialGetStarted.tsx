"use client";

import { Button } from "@inflight/ui";

export function CommercialGetStarted() {
	const handleSmoothScroll = (
		e: React.MouseEvent<HTMLButtonElement>,
		targetId: string,
	) => {
		e.preventDefault();
		const targetElement = document.getElementById(targetId);
		if (targetElement) {
			window.scrollTo({
				top: targetElement.offsetTop,
				behavior: "smooth",
			});
		}
	};

	return (
		<div
			className="custom-bg max-w-[1000px] mx-auto rounded-[20px] overflow-hidden relative flex flex-col justify-center p-8"
			style={{
				minHeight: "264px",
				background:
					"linear-gradient(135deg, #4f46e5 0%, #3b82f6 50%, #0ea5e9 100%)",
			}}
		>
			<div
				id="cloud-4"
				className="absolute top-0 -right-20 opacity-50 z-0 pointer-events-none"
			>
				<img
					className="max-w-[40vw] h-auto"
					src="/illustrations/cloud-1.png"
					alt="Footer Cloud One"
				/>
			</div>
			<div
				id="cloud-5"
				className="absolute bottom-0 left-0 opacity-50 z-0 pointer-events-none"
			>
				<img
					className="max-w-[40vw] h-auto"
					src="/illustrations/cloud-2.png"
					alt="Footer Cloud Two"
				/>
			</div>
			<div className="wrapper mx-auto h-full flex flex-col justify-center items-center relative z-10">
				<div className="text-center max-w-[800px] mx-auto mb-8">
					<h2 className="text-xl sm:text-3xl text-white mb-3">
						Enterprise-grade screen recording, on your infrastructure.
					</h2>
					<p className="text-[1rem] sm:text-lg text-white">
						Deploy Cap on your own servers with complete data sovereignty.
						Maintain full control over your sensitive information while enabling
						seamless team collaboration.
					</p>
				</div>
				<div className="flex flex-col sm:flex-row items-center justify-center space-y-2 sm:space-y-0 sm:space-x-2">
					<Button
						variant="white"
						href="#features"
						size="lg"
						className="w-full sm:w-auto"
						onClick={(e) => handleSmoothScroll(e, "features")}
					>
						Learn More
					</Button>
				</div>
			</div>
		</div>
	);
}
