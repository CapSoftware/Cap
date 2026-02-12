"use client";

import type React from "react";
import { ReadyToGetStarted } from "@/components/ReadyToGetStarted";
import { TextReveal } from "@/components/ui/TextReveal";
import { homepageCopy } from "../../../data/homepage-copy";
import Faq from "./Faq";
import Features from "./Features";
import Header from "./Header";
import { HomePageSchema } from "./HomePageSchema";
import InstantModeDetail from "./InstantModeDetail";
import Pricing from "./Pricing";
import RecordingModePicker from "./RecordingModePicker";
import ScreenshotModeDetail from "./ScreenshotModeDetail";
import StudioModeDetail from "./StudioModeDetail";
import Testimonials from "./Testimonials";

interface HomePageProps {
	serverHomepageCopyVariant?: string;
}

export const HomePage: React.FC<HomePageProps> = ({
	serverHomepageCopyVariant = "",
}) => {
	return (
		<>
			<HomePageSchema />
			<Header serverHomepageCopyVariant={serverHomepageCopyVariant} />
			<div className="space-y-20 sm:space-y-[120px] lg:space-y-[180px]">
				<RecordingModePicker />
				<InstantModeDetail />
				<StudioModeDetail />
				<ScreenshotModeDetail />
				<Features />
				<Testimonials />
				<Pricing />
				<Faq />
			</div>
			<TextReveal className="max-w-[600px] mx-auto leading-[1.2] text-center">
				{homepageCopy.textReveal}
			</TextReveal>
			<ReadyToGetStarted />
		</>
	);
};
