"use client";

import { Button } from "@cap/ui";
import {
	faBookOpen,
	faCopy,
	faGraduationCap,
	faRocket,
	faUsers,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { motion } from "framer-motion";
import { useState } from "react";
import { toast } from "sonner";
import { CommercialCard, ProCard } from "./HomePage/Pricing";

const fadeIn = {
	hidden: { opacity: 0, y: 20 },
	visible: (custom: number = 0) => ({
		opacity: 1,
		y: 0,
		transition: {
			delay: custom * 0.1,
			duration: 0.5,
			ease: "easeOut",
		},
	}),
};

const fadeInFromBottom = {
	hidden: { opacity: 0, y: 50 },
	visible: (custom: number = 0) => ({
		opacity: 1,
		y: 0,
		transition: {
			delay: 0.3 + custom * 0.1,
			duration: 0.6,
			ease: "easeOut",
		},
	}),
};

const staggerContainer = {
	hidden: { opacity: 0 },
	visible: {
		opacity: 1,
		transition: {
			staggerChildren: 0.1,
			delayChildren: 0.2,
		},
	},
};

export const StudentDiscountPage = () => {
	const [copied, setCopied] = useState(false);
	const discountCode = "STUDENT50";

	const copyToClipboard = async () => {
		try {
			await navigator.clipboard.writeText(discountCode);
			setCopied(true);
			toast.success("Discount code copied!");
			setTimeout(() => setCopied(false), 2000);
		} catch (err) {
			toast.error("Failed to copy code");
		}
	};

	return (
		<div className="mt-[120px]">
			<div className="relative z-10 px-5 pt-24 pb-36 w-full">
				<motion.div
					className="mx-auto text-center wrapper wrapper-sm"
					initial="hidden"
					animate="visible"
					variants={staggerContainer}
				>
					<motion.h1
						className="fade-in-down text-[2rem] leading-[2.5rem] md:text-[3.75rem] md:leading-[4rem] relative z-10 text-black mb-4"
						variants={fadeIn}
						custom={1}
					>
						🎓 Student Discount
					</motion.h1>
					<motion.p
						className="mx-auto mb-8 max-w-3xl text-md sm:text-xl text-zinc-500 fade-in-down animate-delay-1"
						variants={fadeIn}
						custom={2}
					>
						Level up your presentations and portfolio with 30% off Cap's premium
						features. Perfect for students, researchers, and future creators.
					</motion.p>

					{/* Clean Discount Badge */}
					<motion.div
						className="mx-auto mt-12 max-w-2xl"
						variants={fadeIn}
						custom={3}
					>
						<div className="p-8 rounded-2xl border shadow-sm border-gray-4 bg-gray-1">
							<h2 className="mb-4 text-2xl font-semibold text-gray-12 text-center">
								30% Student Discount
							</h2>
							<div className="flex justify-center items-center gap-3 mb-4">
								<code className="px-4 py-2 text-lg font-mono font-semibold text-gray-12 bg-gray-4 rounded-lg">
									{discountCode}
								</code>
								<motion.button
									onClick={copyToClipboard}
									className="flex items-center justify-center w-10 h-10 text-gray-10 hover:text-gray-12 bg-gray-4 hover:bg-gray-5 rounded-lg transition-all duration-200"
									title="Copy code"
									whileHover={{ scale: 1.05 }}
									whileTap={{ scale: 0.95 }}
								>
									<FontAwesomeIcon
										icon={faCopy}
										className={`size-4 ${copied ? "text-green-600" : ""}`}
									/>
								</motion.button>
							</div>
							<p className="text-center text-gray-10">
								Use this code at checkout to save 30% on any premium plan
							</p>
						</div>
					</motion.div>

					{/* How to Claim Steps - Clean Version */}
					<motion.div
						className="mx-auto mt-12 max-w-3xl"
						variants={fadeIn}
						custom={4}
					>
						<div className="p-8 rounded-2xl border shadow-sm border-gray-4 bg-gray-1">
							<h3 className="mb-6 text-xl font-semibold text-gray-12 text-center">
								How to claim your discount
							</h3>
							<ol className="list-none space-y-0">
								<div className="flex items-start py-4 border-b border-gray-4 last:border-b-0">
									<div className="flex justify-center items-center mr-4 rounded-full bg-gray-4 size-8 flex-shrink-0">
										<span className="text-sm font-medium text-gray-12">1</span>
									</div>
									<p className="mt-1 text-gray-10">
										Copy the discount code{" "}
										<strong className="text-gray-12">{discountCode}</strong>
									</p>
								</div>
								<div className="flex items-start py-4 border-b border-gray-4 last:border-b-0">
									<div className="flex justify-center items-center mr-4 rounded-full bg-gray-4 size-8 flex-shrink-0">
										<span className="text-sm font-medium text-gray-12">2</span>
									</div>
									<p className="mt-1 text-gray-10">
										Visit the{" "}
										<a
											href="/pricing"
											className="font-semibold underline text-gray-12"
										>
											Pricing
										</a>{" "}
										page and choose a plan
									</p>
								</div>
								<div className="flex items-start py-4 border-b border-gray-4 last:border-b-0">
									<div className="flex justify-center items-center mr-4 rounded-full bg-gray-4 size-8 flex-shrink-0">
										<span className="text-sm font-medium text-gray-12">3</span>
									</div>
									<p className="mt-1 text-gray-10">
										Enter the code at checkout to get{" "}
										<strong className="text-gray-12">30% off</strong>
									</p>
								</div>
							</ol>
						</div>
					</motion.div>

					{/* CTA Buttons */}
					<motion.div
						className="flex flex-col justify-center items-center mt-8 space-y-4 sm:flex-row sm:space-y-0 sm:space-x-4"
						variants={fadeIn}
						custom={5}
					>
						<Button
							variant="primary"
							href="/pricing"
							size="lg"
							className="flex justify-center items-center font-medium"
						>
							View Plans & Pricing
						</Button>
						<Button
							variant="white"
							href="/download"
							size="lg"
							className="flex justify-center items-center font-medium"
						>
							Download Cap Free
						</Button>
					</motion.div>
				</motion.div>
				<img
					src="/illustrations/mask-big-recorder.webp"
					alt="Student Background"
					className="absolute top-0 left-0 z-0 -mt-40 w-full h-auto pointer-events-none opacity-30"
				/>
			</div>

			{/* Main Content */}
			<motion.div
				className="pb-24 wrapper"
				initial="hidden"
				whileInView="visible"
				viewport={{ once: true, margin: "-100px" }}
				variants={staggerContainer}
			>
				{/* Student Use Cases */}
				<motion.div
					className="mx-auto mt-24 max-w-6xl"
					variants={fadeIn}
					custom={1}
				>
					<div className="text-center mb-12">
						<h2 className="inline-block relative mb-6 text-3xl font-medium text-gray-800">
							Perfect for Students
						</h2>
						<p className="text-lg text-gray-600 max-w-2xl mx-auto">
							Whether you're presenting, building your portfolio, or
							collaborating with classmates, Cap helps you create professional
							content that stands out.
						</p>
					</div>

					<div className="grid gap-8 md:grid-cols-3">
						<div className="p-8 bg-gray-1 rounded-2xl border border-gray-4 shadow-sm">
							<div className="flex items-center justify-center w-14 h-14 bg-blue-50 rounded-full mb-6">
								<FontAwesomeIcon
									className="text-blue-500 size-6"
									icon={faBookOpen}
								/>
							</div>
							<h3 className="mb-4 text-xl font-semibold text-gray-800">
								School Projects
							</h3>
							<p className="text-gray-600 leading-relaxed">
								Record presentations, demos, and tutorials for your assignments.
								Create shareable links that are auto-transcribed and summarized,
								with tracking to see when they're opened.
							</p>
						</div>

						<div className="p-8 bg-gray-1 rounded-2xl border border-gray-4 shadow-sm">
							<div className="flex items-center justify-center w-14 h-14 bg-purple-50 rounded-full mb-6">
								<FontAwesomeIcon
									className="text-purple-500 size-6"
									icon={faRocket}
								/>
							</div>
							<h3 className="mb-4 text-xl font-semibold text-gray-800">
								Portfolio Building
							</h3>
							<p className="text-gray-600 leading-relaxed">
								Create professional video content to showcase your work, code
								walkthroughs, and project demos. Share with auto-generated
								transcripts and summaries that help you stand out to employers.
							</p>
						</div>

						<div className="p-8 bg-gray-1 rounded-2xl border border-gray-4 shadow-sm">
							<div className="flex items-center justify-center w-14 h-14 bg-pink-50 rounded-full mb-6">
								<FontAwesomeIcon
									className="text-pink-500 size-6"
									icon={faUsers}
								/>
							</div>
							<h3 className="mb-4 text-xl font-semibold text-gray-800">
								Study Groups
							</h3>
							<p className="text-gray-600 leading-relaxed">
								Share knowledge and collaborate with classmates effectively.
								Create trackable shareable links with auto-generated summaries
								to help your peers learn and succeed.
							</p>
						</div>
					</div>
				</motion.div>

				{/* Ready to Get Started CTA */}
				<motion.div
					className="max-w-[1000px] md:bg-center w-full bg-white min-h-[300px] mx-auto border border-gray-5 my-[100px] rounded-[20px] overflow-hidden relative flex flex-col justify-center p-8"
					style={{
						backgroundImage: "url('/illustrations/ctabg.svg')",
						backgroundSize: "cover",
						backgroundRepeat: "no-repeat",
					}}
					variants={fadeIn}
					custom={2}
				>
					<div className="flex relative z-10 flex-col justify-center items-center mx-auto h-full">
						<div className="text-center max-w-[800px] mx-auto mb-8">
							<h2 className="mb-3 text-3xl md:text-4xl text-gray-12">
								Ready to elevate your student projects?
							</h2>
							<p className="text-lg text-gray-10">
								Join thousands of students already using Cap to create amazing
								content
							</p>
						</div>
						<div className="flex flex-col justify-center items-center space-y-4 w-full sm:flex-row sm:space-y-0 sm:space-x-4">
							<Button
								variant="primary"
								href="/pricing"
								size="lg"
								className="font-medium transform hover:-translate-y-[2px] transition-all duration-300"
							>
								Get Started with 30% Off
							</Button>
							<Button
								variant="white"
								href="/download"
								size="lg"
								className="font-medium transform hover:-translate-y-[2px] transition-all duration-300"
							>
								Try Cap Free First
							</Button>
						</div>
					</div>
				</motion.div>
			</motion.div>
		</div>
	);
};
