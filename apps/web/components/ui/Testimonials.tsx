"use client";

import { testimonials, Testimonial } from "../../data/testimonials";
import Image from "next/image";

interface TestimonialsProps {
  amount?: number;
  title?: string;
  subtitle?: string;
  showHeader?: boolean;
}

export const Testimonials = ({
  amount,
  title = "What our users say about Cap after hitting record",
  subtitle = "Don't just take our word for it. Here's what our users are saying about their experience with Cap.",
  showHeader = true,
}: TestimonialsProps) => {
  const displayedTestimonials = amount
    ? testimonials.slice(0, amount)
    : testimonials;

  return (
    <div>
      {showHeader && (
        <>
          <h2 className="text-3xl text-center md:text-4xl tracking-[-.05em] font-medium text-[--text-primary]">
            {title}
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-center text-gray-400">
            {subtitle}
          </p>
        </>
      )}

      <div className="mt-8 columns-1 md:columns-2 lg:columns-3 gap-3 space-y-3">
        {displayedTestimonials.map((testimonial, i) => (
          <div key={i} className="break-inside-avoid mb-3">
            <TestimonialCard testimonial={testimonial} />
          </div>
        ))}
      </div>
    </div>
  );
};

interface TestimonialCardProps {
  testimonial: Testimonial;
}

const TestimonialCard = ({ testimonial }: TestimonialCardProps) => {
  return (
    <a
      href={testimonial.url}
      target="_blank"
      rel="noopener noreferrer"
      className="p-6 bg-gray-100 rounded-xl border border-gray-200 w-full h-auto hover:scale-[1.015] hover:border-blue-500 hover:shadow-lg transition-all duration-300 cursor-pointer block"
    >
      <div className="flex items-center mb-4">
        <div className="overflow-hidden relative mr-2 w-12 h-12 rounded-full border-2 border-gray-100">
          <Image
            src={testimonial.image}
            alt={testimonial.name}
            width={48}
            height={48}
            className="object-cover"
            loading="lazy"
          />
        </div>
        <div>
          <h3 className="text-sm font-medium text-gray-900">
            {testimonial.name}
          </h3>
          <p className="text-sm font-medium text-gray-400 transition-colors duration-200">
            {testimonial.handle}
          </p>
        </div>
      </div>

      <p className="text-gray-500">{testimonial.content}</p>
    </a>
  );
};
