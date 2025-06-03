"use client";

import { ReadyToGetStarted } from "@/components/ReadyToGetStarted";
import { TextReveal } from "@/components/ui/TextReveal";
import React from "react";
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
      <RecordingModes />
      <TextReveal className="max-w-[600px] mx-auto leading-[1.2] text-center">
        Record. Edit. Share.
      </TextReveal>
      <Features />
      <Testimonials />
      <Pricing />
      <Faq />
      <ReadyToGetStarted />
    </>
  );
};
