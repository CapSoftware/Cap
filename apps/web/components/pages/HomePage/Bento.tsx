"use client";

import { Button } from "@cap/ui";
import clsx from "clsx";
import { motion } from "framer-motion";
import type { ComponentType, ReactNode } from "react";
import { homepageCopy } from "../../../data/homepage-copy";
import AsyncCommentsArt from "./bento/AsyncCommentsArt";
import CapAIArt from "./bento/CapAIArt";
import NativePerformanceArt from "./bento/NativePerformanceArt";
import OpenSourceArt from "./bento/OpenSourceArt";
import PixelPerfectArt from "./bento/PixelPerfectArt";
import StorageRoutingArt from "./bento/StorageRoutingArt";

type ArtComponent = ComponentType<{ className?: string }>;

type LayoutClass = string;

interface CardConfig {
	key: string;
	art: ArtComponent;
	span: LayoutClass;
	artHeight: LayoutClass;
}

const CARD_CONFIG: CardConfig[] = [
	{
		key: "storage",
		art: StorageRoutingArt,
		span: "md:col-span-4",
		artHeight: "h-[260px] md:h-[300px]",
	},
	{
		key: "ai",
		art: CapAIArt,
		span: "md:col-span-2",
		artHeight: "h-[260px] md:h-[300px]",
	},
	{
		key: "async",
		art: AsyncCommentsArt,
		span: "md:col-span-3",
		artHeight: "h-[240px]",
	},
	{
		key: "native",
		art: NativePerformanceArt,
		span: "md:col-span-3",
		artHeight: "h-[240px]",
	},
	{
		key: "oss",
		art: OpenSourceArt,
		span: "md:col-span-2",
		artHeight: "h-[240px]",
	},
	{
		key: "pixel",
		art: PixelPerfectArt,
		span: "md:col-span-4",
		artHeight: "h-[240px]",
	},
];

const cardVariants = {
	hidden: { opacity: 0, y: 24 },
	visible: (custom: number) => ({
		opacity: 1,
		y: 0,
		transition: {
			delay: custom * 0.06,
			duration: 0.55,
			ease: [0.22, 1, 0.36, 1],
		},
	}),
};

interface BentoCardProps {
	title: string;
	description: string;
	span: LayoutClass;
	artHeight: LayoutClass;
	children: ReactNode;
	index: number;
}

const BentoCard = ({
	title,
	description,
	span,
	artHeight,
	children,
	index,
}: BentoCardProps) => (
	<motion.div
		custom={index}
		variants={cardVariants}
		className={clsx(
			"relative col-span-1 flex flex-col overflow-hidden rounded-2xl border border-gray-5 bg-gray-1 shadow-[0_1px_0_0_rgba(0,0,0,0.02),0_18px_40px_-25px_rgba(15,23,42,0.18)]",
			span,
		)}
	>
		<div
			className={clsx(
				"relative flex w-full items-center justify-center overflow-hidden bg-gradient-to-b from-gray-2/60 to-gray-1",
				artHeight,
			)}
		>
			{children}
		</div>
		<div className="flex flex-col gap-2 px-6 pb-6 pt-5 text-left md:px-7 md:pb-7">
			<h3 className="text-lg font-medium text-gray-12 md:text-xl">{title}</h3>
			<p className="text-sm leading-relaxed text-gray-10 md:text-[15px]">
				{description}
			</p>
		</div>
	</motion.div>
);

const Bento = () => {
	const { eyebrow, title, subtitle, cards, cta } = homepageCopy.bento;

	return (
		<div className="mx-auto w-full max-w-[1200px] px-5">
			<motion.div
				initial={{ opacity: 0, y: 30 }}
				whileInView={{ opacity: 1, y: 0 }}
				viewport={{ once: true, margin: "-80px" }}
				transition={{ duration: 0.6 }}
				className="mb-12 text-center md:mb-16"
			>
				<span className="mb-3 inline-block text-xs font-semibold uppercase tracking-[0.2em] text-gray-9">
					{eyebrow}
				</span>
				<h2 className="mb-3 text-3xl font-medium text-gray-12 md:text-4xl">
					{title}
				</h2>
				<p className="mx-auto max-w-[640px] text-base text-gray-10 md:text-lg">
					{subtitle}
				</p>
			</motion.div>

			<motion.div
				initial="hidden"
				whileInView="visible"
				viewport={{ once: true, margin: "-60px" }}
				className="grid grid-cols-1 gap-4 md:grid-cols-6 md:gap-5"
			>
				{cards.map((card, i) => {
					const config = CARD_CONFIG.find((c) => c.key === card.key);
					if (!config) return null;
					const Art = config.art;
					return (
						<BentoCard
							key={card.key}
							title={card.title}
							description={card.description}
							span={config.span}
							artHeight={config.artHeight}
							index={i}
						>
							<Art className="h-full w-full" />
						</BentoCard>
					);
				})}
			</motion.div>

			<div className="mt-12 flex justify-center">
				<Button href={cta.href} variant="dark" size="lg">
					{cta.label}
				</Button>
			</div>
		</div>
	);
};

export default Bento;
