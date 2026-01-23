"use client";

import { Button } from "@inflight/ui";
import MuxPlayer from "@mux/mux-player-react";
import { Clapperboard, Zap } from "lucide-react";
import { ReadyToGetStarted } from "../ReadyToGetStarted";

export const AboutPage = () => {
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
		<div className="mt-[120px]">
			<div className="relative z-10 px-5 pt-24 pb-36 w-full">
				<div className="mx-auto text-center wrapper wrapper-sm">
					<h1 className="fade-in-down text-[2rem] leading-[2.5rem] md:text-[4rem] md:leading-[4.5rem] relative z-10 text-black mb-4">
						The open source screen recording and sharing app
					</h1>
					<p className="mx-auto mb-8 max-w-3xl text-md sm:text-xl text-zinc-500 fade-in-down animate-delay-1">
						Screen recording made simple, secure, and powerful. Cap gives you
						full control over your recordings with a focus on privacy and ease
						of use.
					</p>
				</div>
				<div className="flex flex-col justify-center items-center mb-5 space-y-2 fade-in-up animate-delay-2 sm:flex-row sm:space-y-0 sm:space-x-2">
					<Button
						variant="white"
						href="#video"
						size="lg"
						className="flex justify-center items-center w-full font-medium text-md sm:w-auto"
						onClick={(e) => handleSmoothScroll(e, "video")}
					>
						See it in Action
					</Button>
					<Button
						variant="primary"
						href="/download"
						size="lg"
						className="relative z-[20] w-full font-medium text-md sm:w-auto"
					>
						Download Cap
					</Button>
				</div>
				<img
					src="/illustrations/mask-big-recorder.webp"
					alt="About Background"
					className="absolute top-0 left-0 z-0 -mt-40 w-full h-auto pointer-events-none"
				/>
			</div>

			{/* Main Content */}
			<div className="pb-24 wrapper">
				<div className="mx-auto max-w-4xl">
					<div className="mt-14 mb-32">
						<figure className="mx-auto max-w-4xl space-y-3">
							<img
								src="/cap-team-film.jpeg"
								alt="The Cap team gathered together in San Francisco"
								loading="lazy"
								className="block w-full h-[220px] rounded-2xl object-cover object-center shadow-[0_18px_36px_rgba(15,23,42,0.12)] md:h-[450px]"
							/>
							<figcaption className="px-2 text-sm text-gray-500 text-left">
								The Cap team in San Francisco
							</figcaption>
						</figure>
					</div>

					<div className="mb-12" id="video">
						<div className="text-center max-w-[800px] mx-auto mb-10">
							<h2 className="inline-block relative mb-6 text-3xl font-medium text-gray-800">
								See Cap In Action
								<span className="absolute -bottom-2 left-1/2 w-20 h-1 bg-gray-900 rounded-full transform -translate-x-1/2"></span>
							</h2>
						</div>
						<div className="mx-auto max-w-3xl">
							<div className="rounded-xl overflow-hidden shadow-[0_0_20px_rgba(0,0,0,0.08)]">
								<MuxPlayer
									playbackId="A6oZoUWVZjOIVZB6XnBMLagYnXE6xhDhp8Hcyky018hk"
									metadataVideoTitle="Cap Demo"
									accentColor="#111111"
									style={{ aspectRatio: "16/9", width: "100%" }}
								/>
							</div>
						</div>
					</div>

					<div className="space-y-8">
						<div className="p-8 bg-gray-1 rounded-2xl border border-gray-4 backdrop-blur-sm shadow-[0_0_15px_rgba(0,0,0,0.03)] hover:shadow-[0_5px_30px_rgba(0,0,0,0.05)] transition-all duration-300 transform hover:-translate-y-[2px]">
							<h2 className="mb-4 text-2xl font-semibold text-gray-800">
								Why Cap?
							</h2>
							<p className="leading-relaxed text-gray-600">
								Cap started with a simple idea: great ideas should be easy to
								share. Whether you're explaining a concept, showing how
								something works, or working with others, the tools you use
								should make your job easier, not harder.
							</p>
						</div>

						<div className="grid grid-cols-1 gap-8 md:grid-cols-2">
							<div className="p-8 bg-gray-1 rounded-2xl border border-gray-4 backdrop-blur-sm shadow-[0_0_15px_rgba(0,0,0,0.03)] hover:shadow-[0_5px_30px_rgba(0,0,0,0.05)] transition-all duration-300 transform hover:-translate-y-[2px]">
								<div className="flex justify-center items-center mb-4 w-12 h-12 bg-blue-50 rounded-full">
									<span className="text-xl font-medium text-blue-500">1</span>
								</div>
								<h2 className="mb-4 text-2xl font-semibold text-gray-800">
									The Problem
								</h2>
								<p className="leading-relaxed text-gray-600">
									After years of using other screen recording tools, we found
									they often don't respect your privacy, limit what you can do,
									and lock your content in their systems. Most of these tools
									are run by big companies that are slow to improve and don't
									listen to what users actually need.
								</p>
							</div>

							<div className="p-8 bg-gray-1 rounded-2xl border border-gray-4 backdrop-blur-sm shadow-[0_0_15px_rgba(0,0,0,0.03)] hover:shadow-[0_5px_30px_rgba(0,0,0,0.05)] transition-all duration-300 transform hover:-translate-y-[2px]">
								<div className="flex justify-center items-center mb-4 w-12 h-12 bg-blue-50 rounded-full">
									<span className="text-xl font-medium text-blue-500">2</span>
								</div>
								<h2 className="mb-4 text-2xl font-semibold text-gray-800">
									Our Solution
								</h2>
								<p className="leading-relaxed text-gray-600">
									So we built Cap—a simple, complete screen recording tool that
									anyone can use. Inspired by tools we love and built on
									principles we believe in, our goal is to help you share ideas
									easily while keeping control of your content. Cap makes your
									recordings better with features like automatic captions, easy
									zooming, simple editing, and flexible sharing options.
								</p>
							</div>
						</div>

						<div className="p-8 bg-gray-1 rounded-2xl border border-gray-4 backdrop-blur-sm shadow-[0_0_15px_rgba(0,0,0,0.03)] hover:shadow-[0_5px_30px_rgba(0,0,0,0.05)] transition-all duration-300 transform hover:-translate-y-[2px]">
							<h2 className="mb-4 text-2xl font-semibold text-gray-800">
								Two Ways to Record
							</h2>
							<p className="mb-6 leading-relaxed text-gray-600">
								Cap gives you two simple ways to record:
							</p>
							<div className="grid grid-cols-1 gap-6 md:grid-cols-2">
								<div className="p-6 rounded-xl border bg-gray-50 border-gray-200 transition-transform duration-300 ease-out hover:-translate-y-[2px]">
									<h3 className="mb-3 text-xl font-semibold text-gray-900 flex items-center gap-2">
										<Zap
											aria-hidden="true"
											className="size-5 md:size-6"
											strokeWidth={1.5}
											fill="yellow"
										/>
										Instant Mode
									</h3>
									<p className="text-gray-600">
										Share your screen right away with a simple link—no waiting,
										just record and share in seconds.
									</p>
								</div>
								<div className="p-6 rounded-xl border bg-gray-50 border-gray-200 transition-transform duration-300 ease-out hover:-translate-y-[2px]">
									<h3 className="mb-3 text-xl font-semibold text-gray-900 flex items-center gap-2">
										<Clapperboard
											aria-hidden="true"
											className="size-5 md:size-6"
											strokeWidth={1.5}
											fill="var(--blue-9)"
										/>
										Studio Mode
									</h3>
									<p className="text-gray-600">
										Records at top quality. Captures both your screen and webcam
										separately so you can edit them later.
									</p>
								</div>
							</div>
						</div>

						<div className="p-8 bg-gray-1 rounded-2xl border border-gray-4 backdrop-blur-sm shadow-[0_0_15px_rgba(0,0,0,0.03)] hover:shadow-[0_5px_30px_rgba(0,0,0,0.05)] transition-all duration-300 transform hover:-translate-y-[2px]">
							<h2 className="mb-4 text-2xl font-semibold text-gray-800">
								Privacy First
							</h2>
							<p className="leading-relaxed text-gray-600">
								Unlike other tools, Cap is built with your privacy as a top
								priority. We don't trap your data or force you to use only our
								systems. You can connect your own storage, keeping complete
								control of your recordings forever.
							</p>
						</div>

						<div className="p-8 bg-gray-1 rounded-2xl border border-gray-4  backdrop-blur-sm shadow-[0_0_15px_rgba(0,0,0,0.03)] hover:shadow-[0_5px_30px_rgba(0,0,0,0.05)]transition-all duration-300 transform hover:-translate-y-[2px]">
							<h2 className="mb-4 text-2xl font-semibold text-gray-800">
								Open to Everyone
							</h2>
							<p className="leading-relaxed text-gray-600">
								We believe in being open and transparent. Cap's code is
								available for anyone to see, use, and improve. This means your
								data will always be accessible, and our tool will keep getting
								better through community feedback and contributions.
							</p>
						</div>

						<div className="p-8 bg-gray-1 rounded-2xl border border-gray-4 backdrop-blur-sm shadow-[0_0_15px_rgba(0,0,0,0.03)] hover:shadow-[0_5px_30px_rgba(0,0,0,0.05)] transition-all duration-300 transform hover:-translate-y-[2px]">
							<h2 className="mb-4 text-2xl font-semibold text-gray-800">
								Join Us
							</h2>
							<p className="leading-relaxed text-gray-600">
								We're working to make Cap the best screen recording tool for
								everyone. Whether you're creating content alone, working with a
								startup, or part of a large team, Cap works for you.
							</p>
							<p className="mt-3 leading-relaxed text-gray-600">
								Together, we're making it easier for everyone to share ideas and
								connect—one recording at a time.
							</p>
							<div className="mt-6">
								<Button
									className="inline-flex transform hover:-translate-y-[2px] transition-all duration-300"
									href="/download"
									variant="primary"
									size="lg"
								>
									Download Cap
								</Button>
							</div>
						</div>
					</div>
				</div>

				<div className="mt-16">
					<ReadyToGetStarted />
				</div>
			</div>
		</div>
	);
};
