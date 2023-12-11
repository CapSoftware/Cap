"use client";

import { HomePage } from "@/components/pages/HomePage";
import { ParallaxProvider } from "react-scroll-parallax";

export default function Roadmap() {
  return (
    <ParallaxProvider>
      <HomePage />
    </ParallaxProvider>
  );
}
