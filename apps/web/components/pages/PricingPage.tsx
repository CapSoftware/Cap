"use client";

import { faHeart } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { motion } from "framer-motion";
import { Testimonials } from "../ui/Testimonials";
import ComparePlans from "./_components/ComparePlans";
import Faq from "./HomePage/Faq";
import { CommercialCard, ProCard } from "./HomePage/Pricing";

// Animation variants
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

export const PricingPage = () => {
	const scrollToTestimonials = (e: React.MouseEvent) => {
		e.preventDefault();
		const testimonials = document.getElementById("testimonials");
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
			<div className="py-32 space-y-[200px] md:py-40 wrapper">
				<div>
					<motion.div className="mb-8 text-center" variants={fadeIn} custom={0}>
						<motion.h1
							className="text-4xl md:text-5xl"
							variants={fadeIn}
							custom={1}
						>
							Early Adopter Pricing
						</motion.h1>
						<motion.p
							className="mx-auto mt-3 max-w-[800px]"
							variants={fadeIn}
							custom={2}
						>
							Cap is currently in public beta, and we're offering special early
							adopter pricing to our first users. This pricing will be locked in
							for the lifetime of your subscription.
						</motion.p>
						<motion.div
							onClick={scrollToTestimonials}
							className="flex justify-center cursor-pointer items-center px-5 py-2.5 gap-2 mx-auto mt-6 rounded-full border bg-gray-1 border-gray-5 w-fit hover:bg-gray-2 transition-colors"
							variants={fadeIn}
							custom={3}
							whileHover={{ scale: 1.03 }}
							whileTap={{ scale: 0.98 }}
						>
							<FontAwesomeIcon
								className="text-red-500 size-3.5"
								icon={faHeart}
							/>
							<p className="font-medium text-gray-12">Loved by 15k+ users</p>
						</motion.div>
					</motion.div>

					<motion.div
						className="w-full max-w-[1100px] mx-auto"
						variants={fadeInFromBottom}
						custom={0}
					>
						<div className="flex flex-col gap-8 justify-center items-stretch lg:flex-row">
							<CommercialCard />
							<ProCard />
						</div>
					</motion.div>
				</div>

				{/* Comparison Table (Cap Pro vs Desktop License) */}
				<motion.div
					initial="hidden"
					whileInView="visible"
					variants={fadeInFromBottom}
					viewport={{ once: true, margin: "-100px" }}
					custom={1}
				>
					<ComparePlans />
				</motion.div>

				<motion.div
					variants={fadeInFromBottom}
					custom={4}
					initial="hidden"
					whileInView="visible"
					viewport={{ once: true, margin: "-100px" }}
				>
					<Faq />
				</motion.div>

				<motion.div
					className="mb-32 wrapper"
					id="testimonials"
					variants={fadeIn}
					custom={5}
				>
					<Testimonials
						amount={24}
						title="What our users say about Cap after hitting record"
						subtitle="Don't just take our word for it. Here's what our users are saying about their experience with Cap."
					/>
				</motion.div>
			</div>
		</motion.div>
	);
};
