"use client";

import { faHeart } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Testimonials } from "../ui/Testimonials";
import { CommercialCard, ProCard } from "./HomePage/Pricing";

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
    <div>
      <div className="py-12 mt-16 space-y-24 wrapper">
        <div>
          <div className="mb-8 text-center">
            <h1
              className="text-4xl md:text-5xl"
            >
              Early Adopter Pricing
            </h1>
            <p
              className="mx-auto mt-3 max-w-[800px]"
            >
              Cap is currently in public beta, and we're offering special early
              adopter pricing to our first users. This pricing will be locked in
              for the lifetime of your subscription.
            </p>
            <div
              onClick={scrollToTestimonials}
              className="flex justify-center cursor-pointer items-center px-5 py-2.5 gap-2 mx-auto mt-6 rounded-full border bg-gray-1 border-gray-5 w-fit"
            >
              <FontAwesomeIcon
                className="text-red-500 size-3.5"
                icon={faHeart}
              />
              <p className="font-medium text-gray-12">Loved by 10k+ users</p>
            </div>
          </div>

          <div className="flex flex-col w-full max-w-[1000px] mx-auto gap-8 justify-center items-stretch lg:flex-row">
            <CommercialCard />
            <ProCard />
          </div>
        </div>
        <div className="mb-32 wrapper" id="testimonials">
          <Testimonials
            amount={24}
            title="What our users say about Cap after hitting record"
            subtitle="Don't just take our word for it. Here's what our users are saying about their experience with Cap."
          />
        </div>
        <div>
          <img
            className="mx-auto w-full h-auto"
            src="/illustrations/comparison.png"
            alt="Cap vs Competitors Table"
          />
        </div>
      </div>
    </div>
  );
};
