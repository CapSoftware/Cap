"use client";

import { ReadyToGetStarted } from "../ReadyToGetStarted";
import { Testimonials } from "../ui/Testimonials";

interface TestimonialsPageProps {
	amount?: number;
}

export const TestimonialsPage = ({ amount }: TestimonialsPageProps) => {
	return (
		<>
			<div className="py-32 md:py-40 wrapper">
				<Testimonials
					amount={amount}
					title="What our users say about Cap after hitting record"
					subtitle="Don't just take our word for it. Here's what our users are saying about their experience with Cap."
				/>
			</div>
			<div className="pb-28 wrapper">
				<ReadyToGetStarted />
			</div>
		</>
	);
};
