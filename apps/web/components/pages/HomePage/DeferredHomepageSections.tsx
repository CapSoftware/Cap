"use client";

import dynamic from "next/dynamic";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { homepageCopy } from "../../../data/homepage-copy";
import type { StripePlans } from "./HomepagePricingIsland";
import { InstantIcon, ScreenshotIcon, StudioIcon } from "./modeIcons";

type IdleWindow = Window & {
	requestIdleCallback?: (
		callback: IdleRequestCallback,
		options?: IdleRequestOptions,
	) => number;
	cancelIdleCallback?: (handle: number) => void;
};

const RecordingModePicker = dynamic(() => import("./RecordingModePicker"), {
	ssr: false,
	loading: () => <ModePickerFallback />,
});
const InstantModeDetail = dynamic(() => import("./InstantModeDetail"), {
	ssr: false,
	loading: () => <DetailFallback title="Instant Mode" />,
});
const StudioModeDetail = dynamic(() => import("./StudioModeDetail"), {
	ssr: false,
	loading: () => <DetailFallback title="Studio Mode" />,
});
const ScreenshotModeDetail = dynamic(() => import("./ScreenshotModeDetail"), {
	ssr: false,
	loading: () => <DetailFallback title="Screenshot Mode" />,
});
const Features = dynamic(() => import("./Features"), {
	ssr: false,
	loading: () => <FeaturesFallback />,
});
const Testimonials = dynamic(() => import("./Testimonials"), {
	ssr: false,
	loading: () => <TestimonialsFallback />,
});
const PricingIsland = dynamic(
	() =>
		import("./HomepagePricingIsland").then(
			(module) => module.HomepagePricingIsland,
		),
	{
		ssr: false,
		loading: () => <PricingFallback />,
	},
);
const TextReveal = dynamic(
	() =>
		import("@/components/ui/TextReveal").then((module) => module.TextReveal),
	{
		ssr: false,
		loading: () => <TextRevealFallback />,
	},
);
const ReadyToGetStarted = dynamic(
	() =>
		import("@/components/ReadyToGetStarted").then(
			(module) => module.ReadyToGetStarted,
		),
	{
		ssr: false,
		loading: () => <ReadyFallback />,
	},
);

function LoadWhenVisible({
	children,
	fallback,
	rootMargin = "650px",
}: {
	children: ReactNode;
	fallback: ReactNode;
	rootMargin?: string;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [shouldLoad, setShouldLoad] = useState(false);

	useEffect(() => {
		if (shouldLoad) return;

		const load = () => setShouldLoad(true);
		const idleWindow = window as IdleWindow;
		const scheduleLoad = () => {
			if (idleWindow.requestIdleCallback) {
				const handle = idleWindow.requestIdleCallback(load, { timeout: 1200 });
				return () => idleWindow.cancelIdleCallback?.(handle);
			}

			const timeout = window.setTimeout(load, 120);
			return () => window.clearTimeout(timeout);
		};

		const element = ref.current;
		if (!element || !("IntersectionObserver" in window)) {
			return scheduleLoad();
		}

		let cancelIdleLoad: (() => void) | undefined;
		const observer = new IntersectionObserver(
			([entry]) => {
				if (!entry?.isIntersecting) return;
				observer.disconnect();
				cancelIdleLoad = scheduleLoad();
			},
			{ rootMargin },
		);

		observer.observe(element);

		return () => {
			observer.disconnect();
			cancelIdleLoad?.();
		};
	}, [rootMargin, shouldLoad]);

	return <div ref={ref}>{shouldLoad ? children : fallback}</div>;
}

export function DeferredHomepageSections({ plans }: { plans: StripePlans }) {
	return (
		<div className="space-y-20 sm:space-y-[120px] lg:space-y-[180px]">
			<LoadWhenVisible fallback={<ModePickerFallback />}>
				<RecordingModePicker />
			</LoadWhenVisible>
			<LoadWhenVisible fallback={<DetailFallback title="Instant Mode" />}>
				<InstantModeDetail />
			</LoadWhenVisible>
			<LoadWhenVisible fallback={<DetailFallback title="Studio Mode" />}>
				<StudioModeDetail />
			</LoadWhenVisible>
			<LoadWhenVisible fallback={<DetailFallback title="Screenshot Mode" />}>
				<ScreenshotModeDetail />
			</LoadWhenVisible>
			<LoadWhenVisible fallback={<FeaturesFallback />}>
				<Features />
			</LoadWhenVisible>
			<LoadWhenVisible fallback={<TestimonialsFallback />}>
				<Testimonials />
			</LoadWhenVisible>
			<LoadWhenVisible fallback={<PricingFallback />}>
				<PricingIsland plans={plans} />
			</LoadWhenVisible>
		</div>
	);
}

export function DeferredHomepageClosingSections() {
	return (
		<>
			<LoadWhenVisible fallback={<TextRevealFallback />} rootMargin="800px">
				<TextReveal className="max-w-[600px] mx-auto leading-[1.2] text-center">
					{homepageCopy.textReveal}
				</TextReveal>
			</LoadWhenVisible>
			<LoadWhenVisible fallback={<ReadyFallback />} rootMargin="800px">
				<ReadyToGetStarted />
			</LoadWhenVisible>
		</>
	);
}

function ModePickerFallback() {
	const modes = [
		{ title: "Instant", icon: InstantIcon },
		{ title: "Studio", icon: StudioIcon },
		{ title: "Screenshot", icon: ScreenshotIcon },
	];

	return (
		<section className="w-full max-w-[1000px] mx-auto px-5">
			<div className="text-center mb-8 md:mb-14">
				<span className="inline-block text-xs font-semibold text-gray-9 uppercase tracking-[0.2em] mb-3">
					3 Modes
				</span>
				<h2 className="text-3xl md:text-4xl font-medium text-gray-12 mb-3">
					One app, every workflow
				</h2>
				<p className="text-base md:text-lg text-gray-10 max-w-[600px] mx-auto">
					Whether you need speed, studio quality, or a quick screenshot, Cap has
					a mode for it.
				</p>
			</div>
			<div className="flex justify-center">
				<div className="grid grid-cols-3 gap-4 rounded-full border border-gray-5 bg-gray-3 p-3 md:gap-5 md:p-3.5">
					{modes.map((mode) => {
						const Icon = mode.icon;

						return (
							<div
								key={mode.title}
								className="flex w-[72px] flex-col items-center md:w-[88px]"
							>
								<div className="flex size-[72px] items-center justify-center rounded-full bg-gray-7 md:size-[88px]">
									<Icon className="size-7 text-gray-12 md:size-9" />
								</div>
								<span className="mt-3 text-sm font-medium text-gray-12">
									{mode.title}
								</span>
							</div>
						);
					})}
				</div>
			</div>
		</section>
	);
}

function DetailFallback({ title }: { title: string }) {
	return (
		<section className="mx-auto w-full max-w-[1180px] px-5">
			<div className="grid min-h-[520px] grid-cols-1 overflow-hidden rounded-[28px] border border-gray-5 bg-gray-1 shadow-xl shadow-black/5 lg:grid-cols-[0.9fr_1.1fr]">
				<div className="flex flex-col justify-center gap-5 p-8 md:p-12">
					<span className="w-fit rounded-full bg-blue-2 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-blue-11">
						{title}
					</span>
					<h2 className="text-3xl font-medium text-gray-12 md:text-4xl">
						Designed for fast visual communication
					</h2>
					<p className="text-base leading-7 text-gray-10">
						Cap combines quick capture, polished output, and shareable workflows
						in one native app.
					</p>
				</div>
				<div className="m-6 min-h-[340px] rounded-3xl border border-gray-5 bg-white" />
			</div>
		</section>
	);
}

function FeaturesFallback() {
	const { title, subtitle, features } = homepageCopy.features;

	return (
		<section className="mx-auto w-full max-w-[1440px] px-5 text-center">
			<div className="mb-12 text-center md:mb-16">
				<h2 className="mb-3 text-4xl font-medium text-gray-12">{title}</h2>
				<p className="mx-auto w-full max-w-[600px] text-lg leading-[1.75rem] text-gray-10">
					{subtitle}
				</p>
			</div>
			<div className="grid grid-cols-1 gap-4 md:grid-cols-3">
				{features.slice(0, 6).map((feature) => (
					<article
						key={feature.title}
						className="flex min-h-[320px] flex-col justify-between rounded-xl border border-gray-5 bg-gray-1 p-6 text-left md:p-8"
					>
						<div className="h-40 rounded-xl bg-gray-3" />
						<h3 className="text-lg font-medium text-gray-12">
							{feature.title}
						</h3>
						<p className="mt-2 text-sm leading-relaxed text-gray-10">
							{feature.description}
						</p>
					</article>
				))}
			</div>
		</section>
	);
}

function TestimonialsFallback() {
	return (
		<section className="w-full max-w-[1200px] mx-auto md:px-5">
			<div className="px-5 mb-16 text-center">
				<h2 className="mx-auto mb-3 w-full text-4xl font-medium text-gray-12 text-balance">
					{homepageCopy.testimonials.title}
				</h2>
				<p className="text-lg text-gray-10 w-full max-w-[400px] mx-auto leading-[1.75rem]">
					{homepageCopy.testimonials.subtitle}
				</p>
			</div>
			<div className="grid grid-cols-1 gap-4 px-5 md:grid-cols-3 md:px-0">
				{Array.from({ length: 3 }, (_, index) => (
					<div
						key={index.toString()}
						className="min-h-[180px] rounded-xl border border-gray-5 bg-white p-6 shadow-lg"
					/>
				))}
			</div>
		</section>
	);
}

function PricingFallback() {
	return (
		<section className="w-full max-w-[1100px] mx-auto px-5">
			<div className="px-5 mb-16 text-center">
				<h2 className="mb-3 w-full text-4xl font-medium text-gray-12">
					{homepageCopy.pricing.title}
				</h2>
				<p className="text-lg text-gray-10 max-w-[800px] mx-auto leading-[1.75rem] w-full">
					{homepageCopy.pricing.subtitle}
				</p>
			</div>
			<div className="flex flex-col gap-8 justify-center items-stretch lg:flex-row">
				{[
					homepageCopy.pricing.commercial.title,
					homepageCopy.pricing.pro.title,
				].map((title) => (
					<div
						key={title}
						className="min-h-[520px] flex-1 rounded-2xl border border-gray-5 bg-gray-1 p-8 shadow-lg"
					>
						<div className="mb-8 h-20 rounded-2xl bg-gray-3" />
						<h3 className="text-xl font-semibold text-gray-12">{title}</h3>
					</div>
				))}
			</div>
		</section>
	);
}

function TextRevealFallback() {
	return (
		<div className="relative z-0 mx-auto max-w-[600px] py-24 leading-[1.2] text-center">
			<span className="flex flex-wrap justify-center gap-y-4 p-5 text-center text-3xl font-medium text-gray-12 md:gap-y-8 md:text-[52px]">
				{homepageCopy.textReveal}
			</span>
		</div>
	);
}

function ReadyFallback() {
	return (
		<section className="max-w-[1000px] w-[calc(100%-20px)] min-h-[300px] mx-auto border border-gray-5 my-[150px] md:my-[200px] lg:my-[250px] rounded-[20px] bg-white" />
	);
}
