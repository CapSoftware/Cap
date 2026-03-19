"use client";

import clsx from "clsx";
import {
	type MotionValue,
	motion,
	useScroll,
	useTransform,
} from "framer-motion";
import {
	type ComponentPropsWithoutRef,
	type FC,
	type ReactNode,
	useRef,
} from "react";

export interface TextRevealProps extends ComponentPropsWithoutRef<"div"> {
	children: string;
	wordToStrike?: string;
}

export const TextReveal: FC<TextRevealProps> = ({ children, className }) => {
	const targetRef = useRef<HTMLDivElement | null>(null);
	const { scrollYProgress } = useScroll({
		target: targetRef,
	});

	if (typeof children !== "string") {
		throw new Error("TextReveal: children must be a string");
	}

	const words = children.split(" ");

	return (
		<div ref={targetRef} className={clsx("relative z-0 h-[200vh]", className)}>
			<div
				className={
					"sticky top-0 mx-auto flex h-[50%] max-w-4xl justify-center items-center bg-transparent px-[1rem] py-[5rem]"
				}
			>
				<span
					ref={targetRef}
					className={
						"flex flex-wrap gap-y-4 justify-center p-5 text-3xl font-medium text-center md:gap-y-8 md:text-[52px] text-gray-12"
					}
				>
					{words.map((word, i) => {
						const start = i / words.length;
						const end = start + 1 / words.length;
						return (
							<Word key={i} progress={scrollYProgress} range={[start, end]}>
								{word}
							</Word>
						);
					})}
				</span>
			</div>
		</div>
	);
};

interface WordProps {
	children: ReactNode;
	progress: MotionValue<number>;
	range: [number, number];
}

const Word: FC<WordProps> = ({ children, progress, range }) => {
	const opacity = useTransform(progress, range, [0, 1]);
	return (
		<span className="xl:lg-3 relative mx-1 lg:mx-1.5">
			<span className="absolute opacity-30">{children}</span>
			<motion.span style={{ opacity: opacity }} className="text-gray-12">
				{children}
			</motion.span>
		</span>
	);
};
