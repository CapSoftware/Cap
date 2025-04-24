"use client";

import { Testimonials } from "../ui/Testimonials";

interface TestimonialsPageProps {
  amount?: number;
}

export const TestimonialsPage = ({ amount }: TestimonialsPageProps) => {
  return (
    <div className="py-28 wrapper">
      <Testimonials
        amount={amount}
        title="What our users say about Cap after hitting record"
        subtitle="Don't just take our word for it. Here's what our users are saying about their experience with Cap."
      />
    </div>
  );
};
