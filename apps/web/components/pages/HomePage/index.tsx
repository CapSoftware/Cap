"use client";

import { ReadyToGetStarted } from "@/components/ReadyToGetStarted";
import { TextReveal } from "@/components/ui/TextReveal";
import React from "react";
import { homepageCopy } from "../../../data/homepage-copy";
import Faq from "./Faq";
import Features from "./Features";
import Header from "./Header";
import Pricing from "./Pricing";
import RecordingModes from "./RecordingModes";
import Testimonials from "./Testimonials";

interface HomePageProps {
  serverHomepageCopyVariant?: string;
}

export const HomePage: React.FC<HomePageProps> = ({
  serverHomepageCopyVariant = "",
}) => {
  return (
    <>
      <Header serverHomepageCopyVariant={serverHomepageCopyVariant} />
      <div className="space-y-[150px] lg:space-y-[200px]">
        <RecordingModes />
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
