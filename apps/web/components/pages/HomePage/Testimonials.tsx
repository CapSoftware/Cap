import { Button } from "@cap/ui";
import { motion } from "framer-motion";
import Image from "next/image";
import { useState } from "react";
import { homepageCopy } from "../../../data/homepage-copy";
import { testimonials } from "../../../data/testimonials";

// Combined type for testimonial data and its position/style configuration
interface TestimonialItem {
	name: string;
	handle: string;
	image: string;
	content: string;
	url: string;
	position: { left?: string; right?: string; top?: string };
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
	const { name, handle, image, content, url, position, rotation, zIndex } =
		item;

	return (
		<motion.a
			href={url}
			target="_blank"
			rel="noopener noreferrer"
			className="md:absolute bg-white p-6 h-fit md:h-auto rounded-xl transition-shadow duration-200 ease-in-out border border-gray-5 shadow-lg min-w-[300px] md:min-w-min md:w-full md:max-w-[300px] cursor-pointer"
			style={{
				...position,
				transformOrigin: "center center",
				boxShadow: isHovered
					? "0 20px 25px rgba(0, 0, 0, 0.1)"
					: "0 4px 10px rgba(0, 0, 0, 0.05)",
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
				<div className="overflow-hidden relative mr-3 w-12 h-12 rounded-full border-2 border-gray-100">
					<Image
						src={image}
						key={image}
						alt={`${name}'s profile picture`}
						fill
						className="object-cover"
					/>
				</div>
				<div>
					<h4 className="text-lg font-semibold text-gray-12">{name}</h4>
					<p className="text-sm text-gray-10">{handle}</p>
				</div>
			</div>
			<p className="text-sm leading-relaxed text-gray-10">{content}</p>
		</motion.a>
	);
};

// Combined testimonial data with position and style configurations
const testimonialItems: TestimonialItem[] = [
	{
		...testimonials[2],
		position: { right: "5%", top: "5%" },
		rotation: 8,
		zIndex: 4,
	},
	{
		...testimonials[25],
		position: { right: "25%", top: "15%" },
		rotation: -5,
		zIndex: 3,
	},
	{
		...testimonials[9],
		position: { left: "5%", top: "10%" },
		rotation: -8,
		zIndex: 2,
	},
	{
		...testimonials[22],
		position: { left: "25%", top: "5%" },
		rotation: 5,
		zIndex: 1,
	},
	{
		...testimonials[12],
		position: { right: "18%", top: "40%" },
		rotation: 8,
		zIndex: 3,
	},
	{
		...testimonials[10],
		position: { left: "20%", top: "40%" },
		rotation: -4,
		zIndex: 0,
	},
];

// Main Testimonials component
const Testimonials = () => {
	return (
		<div className="w-full max-w-[1200px] mx-auto md:px-5">
			<div className="px-5 mb-16 text-center">
				<h1 className="mb-3 text-4xl font-medium text-gray-12 w-full max-w-[500px] mx-auto text-balance">
					{homepageCopy.testimonials.title}
				</h1>
				<p className="text-lg text-gray-10 text-balance mx-auto leading-[1.75rem] w-full max-w-[500px]">
					{homepageCopy.testimonials.subtitle}
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
				className="mx-auto mt-10 md:mt-0 w-fit"
				variant="dark"
				size="lg"
			>
				{homepageCopy.testimonials.cta}
			</Button>
		</div>
	);
};

export default Testimonials;
