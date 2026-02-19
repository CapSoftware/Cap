"use client";

import { faHeart } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { motion } from "framer-motion";
import { Testimonials } from "../ui/Testimonials";
import ComparePlans from "./_components/ComparePlans";
import Faq from "./HomePage/Faq";
import { CommercialCard, ProCard } from "./HomePage/Pricing";
import { EnterpriseCard } from "./HomePage/Pricing/EnterpriseCard";

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
			<div className="py-32 space-y-[100px] md:py-40 wrapper">
				<div>
					<motion.div
						className="mb-16 text-center"
						variants={fadeIn}
						custom={0}
					>
						<motion.h1
							className="text-4xl md:text-5xl"
							variants={fadeIn}
							custom={1}
						>
							Simple, Flexible Pricing
						</motion.h1>
						<motion.p
							className="mx-auto mt-3 max-w-[800px]"
							variants={fadeIn}
							custom={2}
						>
							Cap is currently in public beta, and we're offering special early
							adopter pricing to our first users. This pricing will be locked in
							for the lifetime of your subscription. Switching from Loom? Import
							all your existing videos with our built-in Loom importer.
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
							<p className="font-medium text-gray-12">Loved by 25k+ users</p>
						</motion.div>
					</motion.div>

					<motion.div
						className="w-full max-w-[1400px] mx-auto"
						variants={fadeInFromBottom}
						custom={0}
					>
						<div className="flex flex-col gap-8 justify-center items-stretch lg:flex-row">
							<CommercialCard />
							<ProCard />
							<EnterpriseCard />
						</div>
					</motion.div>
				</div>

				{/* Comparison Table (Cap Pro vs Desktop License) */}
				<div>
					<ComparePlans />
				</div>

				<div>
					<Faq />
				</div>

				<div className="mb-32 wrapper" id="testimonials">
					<Testimonials
						amount={24}
						title="What our users say about Cap after hitting record"
						subtitle="Don't just take our word for it. Here's what our users are saying about their experience with Cap."
					/>
				</div>
			</div>
		</motion.div>
	);
};
