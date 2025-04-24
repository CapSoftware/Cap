// million-ignore

"use client";

import { faXTwitter } from "@fortawesome/free-brands-svg-icons";
import { faHeart } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import Image from "next/image";
import Masonry, { ResponsiveMasonry } from "react-responsive-masonry";

// Fake testimonial data
const testimonials = [
  {
    name: "Sarah Johnson",
    xhandle: "sarahj",
    image: "https://randomuser.me/api/portraits/women/32.jpg",
    content:
      "Cap has transformed our collaboration workflow! The screen recording feature is so intuitive that our entire team adopted it within days. We've cut meeting times by 50% by sharing quick caps instead of scheduling calls.",
  },
  {
    name: "Michael Chen",
    xhandle: "michaelc",
    image: "https://randomuser.me/api/portraits/men/45.jpg",
    content:
      "I've tried numerous screen recording tools, but Cap stands out with its clean interface. The ability to annotate directly on recordings has made explaining complex code so much easier. My PR reviews are now much more efficient since I can visually explain my thought process.",
  },
  {
    name: "Emily Rodriguez",
    xhandle: "emilyr",
    image: "https://randomuser.me/api/portraits/women/65.jpg",
    content:
      "As a designer, Cap is now essential to my workflow. I use it daily to share my designs and collect feedback.",
  },
  {
    name: "David Kim",
    xhandle: "davidk",
    image: "https://randomuser.me/api/portraits/men/22.jpg",
    content:
      "Cap has been a game-changer for our small team. We use it daily for bug reports, feature demos, and customer support. The organization features help us keep everything in one place. The ability to quickly share sessions with temporary links has made our client presentations so much smoother. Our investors were particularly impressed with how we use Cap to showcase product updates.",
  },
  {
    name: "Priya Patel",
    xhandle: "priyap",
    image: "https://randomuser.me/api/portraits/women/26.jpg",
    content:
      "I create tutorial videos for our products, and Cap makes the process incredibly simple. The editing tools are just right!",
  },
  {
    name: "James Wilson",
    xhandle: "jamesw",
    image: "https://randomuser.me/api/portraits/men/67.jpg",
    content:
      "The integration with our existing workflow tools is flawless. Cap has become an essential part of our development process, especially for async communication across time zones. Being able to record debugging sessions and share them with teammates in different countries has made our distributed team much more efficient. I honestly don't know how we collaborated effectively before using Cap!",
  },
  {
    name: "Olivia Taylor",
    xhandle: "oliviat",
    image: "https://randomuser.me/api/portraits/women/17.jpg",
    content:
      "We've seen a 40% improvement in customer issue resolution time since adopting Cap. Being able to quickly record and share screen captures has revolutionized our support process. Now our customers can show us exactly what's happening, and we can send them guided solutions.",
  },
  {
    name: "Thomas Wright",
    xhandle: "thomasmw",
    image: "https://randomuser.me/api/portraits/men/33.jpg",
    content:
      "As an online educator, I needed something reliable and easy. Cap delivers on all fronts.",
  },
  {
    name: "Sophia Martinez",
    xhandle: "sophiam",
    image: "https://randomuser.me/api/portraits/women/42.jpg",
    content:
      "Cap has changed how we communicate product requirements to our engineering teams. Instead of writing lengthy documents, I can now create quick visual walkthroughs that clearly demonstrate user journeys and expected behaviors. This has dramatically reduced misunderstandings and rework. The ability to organize recordings by project and add tags makes it easy to maintain a visual knowledge base that new team members can quickly reference.",
  },
  {
    name: "Alex Thompson",
    xhandle: "alexthompson",
    image: "https://randomuser.me/api/portraits/men/52.jpg",
    content:
      "As a freelancer, showing my progress to clients used to be time-consuming. Cap simplified everything!",
  },
  {
    name: "Lily Chen",
    xhandle: "lilyc",
    image: "https://randomuser.me/api/portraits/women/53.jpg",
    content:
      "I used to send screenshots of my progress to clients, but Cap made it so much easier. Now I can just share a quick cap and they can see exactly what I'm working on. It's so much faster!",
  },
  {
    name: "Ethan Davis",
    xhandle: "ethand",
    image: "https://randomuser.me/api/portraits/men/54.jpg",
    content:
      "I used to send screenshots of my progress to clients, but Cap made it so much easier. Now I can just share a quick cap and they can see exactly what I'm working on. It's so much faster!",
  },
];

export const TestimonialsPage = () => {
  return (
    <div className="py-20 wrapper wrapper-sm">
      <h1 className="text-4xl mt-10 text-center md:text-5xl tracking-[-.05em] font-medium text-[--text-primary]">
        We all{" "}
        <span>
          <FontAwesomeIcon
            icon={faHeart}
            className="mx-2 text-red-500 size-10"
          />
        </span>
        Cap
      </h1>

      <p className="mx-auto mt-4 max-w-2xl text-center text-gray-400">
        Don't just take our word for it. Here's what people are saying about
        their experience with Cap.
      </p>

      <ResponsiveMasonry
        columnsCountBreakPoints={{ 350: 1, 750: 2, 900: 3 }}
        gutterBreakpoints={{ 350: "12px", 750: "16px", 900: "24px" }}
        className="mt-12"
      >
        <Masonry>
          {testimonials.map((testimonial, i) => (
            <TestimonialCard key={i} testimonial={testimonial} />
          ))}
        </Masonry>
      </ResponsiveMasonry>
    </div>
  );
};

interface TestimonialCardProps {
  testimonial: {
    name: string;
    xhandle: string;
    image: string;
    content: string;
  };
}

const TestimonialCard = ({ testimonial }: TestimonialCardProps) => {
  return (
    <div className="p-6 bg-gray-100 rounded-xl border border-gray-200">
      <div className="flex items-center mb-4">
        <div className="overflow-hidden relative mr-2 w-12 h-12 rounded-full border-2 border-gray-100">
          <Image
            src={testimonial.image}
            alt={testimonial.name}
            width={48}
            height={48}
            className="object-cover"
          />
        </div>
        <div>
          <h3 className="text-sm font-medium text-gray-900">
            {testimonial.name}
          </h3>
          <a
            href={`https://x.com/${testimonial.xhandle}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <div className="flex gap-0.5 items-center mt-1 duration-300 group cursor-pointer">
              <FontAwesomeIcon
                icon={faXTwitter}
                className="size-3.5 group-hover:text-blue-300 text-gray-500 transition-colors duration-200"
              />
              <p className="text-xs font-medium text-gray-500 transition-colors duration-200 group-hover:text-blue-300">
                {testimonial.xhandle}
              </p>
            </div>
          </a>
        </div>
      </div>

      <p className="text-sm text-gray-500">{testimonial.content}</p>
    </div>
  );
};
