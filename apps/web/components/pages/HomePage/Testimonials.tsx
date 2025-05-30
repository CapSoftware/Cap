import { Button } from "@cap/ui";
import { motion } from "framer-motion";
import Image from "next/image";
import { useState } from "react";

// Combined type for testimonial data and its position/style configuration
interface TestimonialItem {
  name: string;
  username: string;
  avatarSrc: string;
  testimonial: string;
  position: { left?: string; right?: string; top: string };
  rotation: number;
  zIndex: number;
}

// Card component props - now directly takes the TestimonialItem
interface TestimonialCardProps {
  item: TestimonialItem;
}

// Testimonial card component
const TestimonialCard: React.FC<TestimonialCardProps> = ({ item }) => {
  const [isHovered, setIsHovered] = useState(false);
  // Destructure all properties from item, including position, rotation and zIndex
  const { name, username, avatarSrc, testimonial, position, rotation, zIndex } = item;

  return (
    <motion.div
      className="md:absolute bg-white p-6 h-fit md:h-auto rounded-xl transition-shadow duration-200 ease-in-out border border-gray-5 shadow-lg min-w-[300px] md:min-w-min md:w-full md:max-w-[300px] cursor-pointer"
      style={{
        ...position,
        transformOrigin: "center center",
        boxShadow: isHovered ? "0 20px 25px rgba(0, 0, 0, 0.1)" : "0 4px 10px rgba(0, 0, 0, 0.05)",
      }}
      initial={{
        rotate: rotation,
        zIndex: zIndex,
      }}
      whileHover={{
        rotate: 0,
        scale: 1.05,
        y: -5,
        zIndex: 50,
        transition: { duration: 0.3, ease: "easeOut" },
      }}
      onHoverStart={() => setIsHovered(true)}
      onHoverEnd={() => setIsHovered(false)}
    >
      <div className="flex items-center mb-4">
        <div className="overflow-hidden relative mr-3 w-12 h-12 rounded-full">
          <Image
            src={avatarSrc}
            key={avatarSrc}
            alt={`${name}'s profile picture`}
            fill
            className="object-cover"
          />
        </div>
        <div>
          <h4 className="text-lg font-semibold text-gray-12">{name}</h4>
          <p className="text-sm text-gray-10">{username}</p>
        </div>
      </div>
      <p className="text-sm leading-relaxed text-gray-10">{testimonial}</p>
    </motion.div>
  );
};

// Combined testimonial data with position and style configurations
const testimonialItems: TestimonialItem[] = [
  {
    name: "Bilal Budhani",
    username: "@BilalBudhani",
    avatarSrc: "/testimonials/BilalBudhani.jpg",
    testimonial: "Tried @Cap v 0.3 beta and found an issue while exporting video. Wrote to @richellemcroy about the problem and within 30 minutes later the issue was resolved. Checkout Cap.so!",
    position: { left: '5%', top: '10%' }, 
    rotation: -8, 
    zIndex: 4 
  },
  {
    name: "Greg LD",
    username: "@Greg__LD",
    avatarSrc: "/testimonials/Greg__LD.jpg",
    testimonial: "I recently tested @Cap v 0.3 beta and encountered a glitch during video export, reached out to @richellemcroy for assistance, and within about 30 minutes, the issue was resolved. I'm thoroughly impressed! Definitely give Cap.so a try!",
    position: { left: '25%', top: '5%' }, 
    rotation: 5, 
    zIndex: 3 
  },
  {
    name: "Guillermo Rauch",
    username: "@guillermo_rauch",
    avatarSrc: "/testimonials/guillermo_rauch.jpg",
    testimonial: "I had a great experience using @Cap v 0.3 beta. I faced a minor bug during video import, but after contacting @sarahpixels for help, they fixed it promptly! Highly recommended! Highly recommend trying Cap.so!",
    position: { right: '25%', top: '15%' }, 
    rotation: -5, 
    zIndex: 2 
  },
  {
    name: "Steven Tey",
    username: "@steven_tey",
    avatarSrc: "/testimonials/steven_tey.jpg",
    testimonial: "Tried @Cap v 0.3 beta and encountered a minor bug with my video. I reached out to @richellemcroy for support, and within 30 minutes, the issue was resolved. I'm giving Cap.so a shot!",
    position: { right: '5%', top: '5%' }, 
    rotation: 8, 
    zIndex: 1 
  },
  {
    name: "Dozibe",
    username: "@Dozibe",
    avatarSrc: "/testimonials/dozibe.jpg",
    testimonial: "Tried @Cap v 0.3 beta and found an issue while exporting video. Wrote to @richellemcroy about the problem and within 30 minutes later the issue was resolved. Checkout Cap.so!",
    position: { right: '20%', top: '40%' }, 
    rotation: 8, 
    zIndex: 0
  },
  {
    name: "Campak",
    username: "@Campak",
    avatarSrc: "/testimonials/campak.jpg",
    testimonial: "Tried @Cap v 0.3 beta and found an issue while exporting video. Wrote to @richellemcroy about the problem and within 30 minutes later the issue was resolved. Checkout Cap.so!",
    position: { left: '20%', top: '40%' }, 
    rotation: -4, 
    zIndex: 0 
  },
];

// Main Testimonials component
const Testimonials = () => {
  return (
    <div className="w-full max-w-[1200px] mx-auto my-[250px] md:px-5">
      <div className="px-5 mb-16 text-center md:text-left">
        <h2 className="mb-3 w-full max-w-[440px]">
          What our users say about Cap after hitting record
        </h2>
        <p className="text-lg leading-[1.75rem] w-full max-w-[500px]">
          Don't just take our word for it. Here's what our users are saying
          about their experience with Cap.
        </p>
      </div>

      <div className="relative w-full min-h-fit py-10 md:h-[600px] px-5 md:px-0 overflow-x-auto">
        {/* Card layout container */}
        <div className="flex flex-row w-full h-full md:relative">
          {testimonialItems.map((item) => (
            <TestimonialCard key={item.name} item={item} />
          ))}
        </div>
      </div>
      <Button 
      href="/testimonials"
      className="mx-auto mt-10 md:mt-0 w-fit" variant="primary" size="lg">
        View more
      </Button>
    </div>
  );
};

export default Testimonials;