"use client";

import { Button } from "@cap/ui";
import clsx from "clsx";
import { memo } from "react";
import { WhenVisible } from "@/components/ui/WhenVisible";
import { Fit, Layout, useRive } from "@/lib/rive";
import { homepageCopy } from "../../../data/homepage-copy";

type FeatureArt = {
	artboard: string;
	className: string;
};

type Feature = {
	title: string;
	description: string;
	art: FeatureArt;
	relative?: {
		top?: number;
		bottom?: number;
		left?: number;
		right?: number;
	};
};

const BentoRive = memo(({ artboard }: { artboard: string }) => {
	const { RiveComponent } = useRive({
		src: "/rive/bento.riv",
		artboard,
		animations: ["in"],
		autoplay: true,
		layout: new Layout({
			fit: Fit.Contain,
		}),
	});

	return <RiveComponent className="w-full h-full" />;
});

const BentoArt = ({ artboard, className }: FeatureArt) => (
	<WhenVisible className={className}>
		<BentoRive artboard={artboard} />
	</WhenVisible>
);

const featureArt: FeatureArt[] = [
	{
		artboard: "storageoptions",
		className: "w-full max-w-[350px] mx-auto h-[275px]",
	},
	{
		artboard: "privacyfirst",
		className: "w-full max-w-[560px] mx-auto h-[250px]",
	},
	{ artboard: "collab", className: "w-full max-w-[500px] mx-auto h-[280px]" },
	{
		artboard: "platformsupport",
		className: "w-full max-w-[500px] mx-auto h-[280px]",
	},
	{
		artboard: "videocapture",
		className: "w-full max-w-[420px] mx-auto h-[244px]",
	},
	{ artboard: "everyone", className: "w-full max-w-[600px] mx-auto h-[300px]" },
	{ artboard: "capai", className: "w-full max-w-[550px] mx-auto h-[300px]" },
];

const features: Feature[] = homepageCopy.features.features.map(
	(feature, index) => {
		const relatives = [
			{ top: 25 },
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		];

		return {
			title: feature.title,
			description: feature.description,
			art: featureArt[index] ?? { artboard: "", className: "" },
			relative: relatives[index],
		};
	},
);

const Features = () => {
	return (
		<div className="text-center max-w-[1440px] mx-auto px-5">
			<h2 className="mb-3 text-4xl font-medium text-gray-12">
				{homepageCopy.features.title}
			</h2>
			<p className="text-lg text-gray-10 leading-[1.75rem] w-full max-w-[600px] mx-auto">
				{homepageCopy.features.subtitle}
			</p>
			<div className="flex flex-col gap-4 mt-[52px]">
				<div className="grid grid-cols-1 gap-4 mx-auto w-full md:grid-cols-2">
					{features.slice(3, 5).map((feature) => (
						<FeatureCard
							key={feature.title}
							title={feature.title}
							className="flex-1 min-w-full"
							description={feature.description}
							art={feature.art}
							relative={feature.relative}
						/>
					))}
				</div>

				<div className="grid grid-cols-1 gap-4 md:grid-cols-3">
					{features.slice(0, 3).map((feature) => (
						<FeatureCard
							key={feature.title}
							title={feature.title}
							description={feature.description}
							art={feature.art}
							relative={feature.relative}
						/>
					))}
				</div>

				<div className="grid grid-cols-1 gap-4 mx-auto w-full md:grid-cols-2">
					{features.slice(5, 7).map((feature) => (
						<FeatureCard
							key={feature.title}
							title={feature.title}
							description={feature.description}
							art={feature.art}
							relative={feature.relative}
						/>
					))}
				</div>
			</div>

			<div className="mt-10">
				<Button
					href="/features"
					variant="dark"
					size="lg"
					className="inline-flex"
				>
					View all features
				</Button>
			</div>
		</div>
	);
};

const FeatureCard = ({
	title,
	description,
	art,
	relative,
	className,
}: {
	title: string;
	description: string;
	art?: FeatureArt;
	className?: string;
	relative?: {
		top?: number;
		bottom?: number;
		left?: number;
		right?: number;
	};
}) => {
	return (
		<div
			className={clsx(
				"flex flex-col gap-10 justify-evenly p-6 text-left rounded-xl border md:p-8 bg-gray-1 border-gray-5",
				className,
			)}
		>
			<div
				style={{
					top: relative?.top,
					bottom: relative?.bottom,
					left: relative?.left,
					right: relative?.right,
				}}
				className="relative flex-1 flex-grow justify-center content-center"
			>
				{art ? (
					<BentoArt artboard={art.artboard} className={art.className} />
				) : null}
			</div>
			<div className="flex flex-col gap-2 justify-end h-fit">
				<h3 className="text-lg font-medium">{title}</h3>
				<p className="text-base text-gray-10">{description}</p>
			</div>
		</div>
	);
};

export default Features;
