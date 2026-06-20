"use client";

import { faHeart } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { motion } from "framer-motion";
import { type MouseEvent, useId } from "react";
import { Testimonials } from "../ui/Testimonials";
import ComparePlans from "./_components/ComparePlans";
import Faq from "./HomePage/Faq";
import { CommercialCard } from "./HomePage/Pricing/CommercialCard";
import { EnterpriseCard } from "./HomePage/Pricing/EnterpriseCard";
import { ProCard } from "./HomePage/Pricing/ProCard";

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
	hidden: { opacity: 0, y: 40 },
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

export const PricingPage = () => {
	const testimonialsId = useId();

	const scrollToTestimonials = (e: MouseEvent) => {
		e.preventDefault();
		const testimonials = document.getElementById(testimonialsId);
		if (testimonials) {
			const offset = 80;
			const topPos =
				testimonials.getBoundingClientRect().top + window.pageYOffset - offset;
			window.scrollTo({
				top: topPos,
				behavior: "smooth",
			});
		}
	};

	return (
		<motion.div initial="hidden" animate="visible" variants={staggerContainer}>
			<div className="py-32 space-y-[120px] md:py-40 wrapper">
				<div>
					<motion.div
						className="mb-12 text-center"
						variants={fadeIn}
						custom={0}
					>
						<motion.h1
							className="mt-3 text-4xl font-medium tracking-tight md:text-5xl text-gray-12"
							variants={fadeIn}
							custom={2}
						>
							Simple, flexible pricing
						</motion.h1>
						<motion.button
							type="button"
							onClick={scrollToTestimonials}
							className="hidden sm:flex justify-center cursor-pointer items-center px-5 py-2.5 gap-2 mx-auto mt-6 rounded-full border bg-gray-1 border-gray-5 w-fit hover:bg-gray-2 transition-colors"
							variants={fadeIn}
							custom={4}
							whileHover={{ scale: 1.03 }}
							whileTap={{ scale: 0.98 }}
						>
							<FontAwesomeIcon
								className="text-red-500 size-3.5"
								icon={faHeart}
							/>
							<span className="text-sm font-medium text-gray-12">
								Trusted by 40,000+ teams, builders and creators
							</span>
						</motion.button>
					</motion.div>

					<motion.div
						className="grid gap-6 items-stretch mx-auto w-full max-w-[1080px] pt-3 lg:grid-cols-3"
						variants={fadeInFromBottom}
						custom={0}
					>
						<CommercialCard />
						<ProCard />
						<EnterpriseCard />
					</motion.div>
				</div>

				<div>
					<ComparePlans />
				</div>

				<div>
					<Faq />
				</div>

				<div className="mb-32 wrapper" id={testimonialsId}>
					<Testimonials
						amount={24}
						title="Teams & creators love Cap"
						subtitle="Don't just take our word for it. Here's what our users are saying about their experience with Cap."
					/>
				</div>
			</div>
		</motion.div>
	);
};
