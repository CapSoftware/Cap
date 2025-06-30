"use client";

import { motion } from "framer-motion";
import Image from "next/image";
import { Testimonial, testimonials } from "../../data/testimonials";

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

  const getRandomDelay = () => 0.15 + Math.random() * 0.3;

  return (
    <div>
      {showHeader && (
        <>
          <motion.h2
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="text-3xl text-center md:text-4xl tracking-[-.05em] text-gray-12"
          >
            {title}
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.1 }}
            className="mx-auto mt-3 max-w-2xl text-center text-gray-10"
          >
            {subtitle}
          </motion.p>
        </>
      )}

      <div className="gap-3 mt-8 space-y-3 columns-1 md:columns-2 lg:columns-3">
        {displayedTestimonials.map((testimonial, i) => (
          <motion.div
            key={i}
            className="mb-3 break-inside-avoid"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              duration: 0.3,
              delay: getRandomDelay(),
              ease: "easeOut",
            }}
          >
            <TestimonialCard testimonial={testimonial} />
          </motion.div>
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
    <motion.a
      href={testimonial.url}
      target="_blank"
      rel="noopener noreferrer"
      className="p-6 bg-gray-2 rounded-xl border border-gray-4 w-full h-auto hover:scale-[1.008] hover:border-blue-500 hover:shadow-lg transition-all duration-300 cursor-pointer block"
      whileHover={{ scale: 1.03 }}
      whileTap={{ scale: 0.98 }}
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
    </motion.a>
  );
};
