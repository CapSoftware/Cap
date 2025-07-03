// million-ignore

"use client";

import { CommercialGetStarted } from "@/components/CommercialGetStarted";
import { Button } from "@cap/ui";
import { LogoSection } from "@/components/pages/_components/LogoSection";
import { FeatureCard } from "@/components/pages/_components/FeatureCard";

export const SelfHostingPage = () => {
  const handleSmoothScroll = (
    e: React.MouseEvent<HTMLButtonElement>,
    targetId: string
  ) => {
    e.preventDefault();
    const targetElement = document.getElementById(targetId);
    if (targetElement) {
      window.scrollTo({
        top: targetElement.offsetTop,
        behavior: "smooth",
      });
    }
  };

  return (
    <>
      <div className="mt-[120px]">
        <div className="relative z-10 px-5 pt-24 pb-36 w-full">
          <div className="mx-auto text-center wrapper wrapper-sm">
            <h1 className="fade-in-down text-[2rem] font-medium leading-[2.5rem] md:text-[3.75rem] md:leading-[4rem] relative z-10 text-black mb-4">
              Self-host Cap
            </h1>
            <p className="mx-auto mb-8 max-w-3xl text-md sm:text-xl text-zinc-500 fade-in-down animate-delay-1">
              Deploy Cap on your own infrastructure with full control over your
              data. Ideal for enterprises and organizations with specific
              security requirements or those wanting to white label the
              platform.
            </p>
          </div>
          <div className="flex flex-col justify-center items-center mb-5 space-y-2 fade-in-up animate-delay-2 sm:flex-row sm:space-y-0 sm:space-x-2">
            <Button
              variant="blue"
              href="#features"
              size="lg"
              className="flex justify-center items-center w-full font-medium text-md sm:w-auto"
              onClick={(e) => handleSmoothScroll(e, "features")}
            >
              Learn More
            </Button>
          </div>
          <img
            src="/illustrations/mask-big-recorder.webp"
            alt="Self-hosting Background"
            className="absolute top-0 left-0 z-0 -mt-40 w-full h-auto pointer-events-none"
          />
        </div>
        <LogoSection />
        <div className="pb-32 wrapper md:pb-40" id="features">
          <div className="space-y-3">
            {/* Section 1: 35% / 65% split */}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
              <div className="md:col-span-5">
                <FeatureCard
                  title="Privacy-first"
                  description="Host Cap on your own servers with complete data sovereignty. Maintain full control over your sensitive information and ensure compliance with your organization's security policies and regulatory requirements."
                  imagePath="/illustrations/privacy.webp"
                  imageAlt="Complete Control"
                  imageHeight="h-[280px]"
                />
              </div>
              <div className="md:col-span-7">
                <FeatureCard
                  title="Multi-Platform Support"
                  description="Self-hosted Cap works seamlessly across macOS and Windows, giving your team the flexibility to collaborate regardless of their device preference. Deploy once and enable your entire organization to capture, share, and collaborate from any device."
                  imagePath="/illustrations/multiplatmain.png"
                  bg="/illustrations/multiplatbg.webp"
                  imageAlt="Enterprise-Ready"
                  className="bg-[center_top_-90px] bg-no-repeat bg-cover lg:bg-[center_top_-60px]"
                  imageHeight="h-[280px]"
                />
              </div>
            </div>

            {/* Section 2: 65% / 35% split */}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
              <div className="md:col-span-8">
                <FeatureCard
                  title="Unlimited Recording and Cloud Storage"
                  bg="/illustrations/multiplatbg.webp"
                  description="Configure storage limits based on your infrastructure capacity. Self-hosting eliminates cloud storage fees and gives you complete control over retention policies, ideal for teams with high-volume recording needs or long-term archival requirements."
                  imagePath="/illustrations/cloud-feature.webp"
                  imageAlt="White Labeling"
                  imageHeight="h-[215px]"
                  className="lg:bg-[center_top_-150px] bg-[center_top_-120px] bg-no-repeat bg-cover"
                />
              </div>
              <div className="md:col-span-4">
                <FeatureCard
                  title="High-Quality Video Capture"
                  description="Deliver crystal-clear recordings to your team with self-hosted infrastructure optimized for your network. Eliminate quality degradation from third-party services and ensure consistent performance across your organization."
                  imagePath="/illustrations/video-capture.webp"
                  imageAlt="Data Sovereignty"
                  imageHeight="h-[224px]"
                />
              </div>
            </div>

            {/* Section 3: Full width */}
            <div className="grid grid-cols-1">
              <FeatureCard
                title="Advanced Team Collaboration"
                description="Enable seamless knowledge sharing across departments with customizable access controls and team workspaces. Self-hosted Cap provides enterprise-grade collaboration features that integrate with your existing authentication systems and team structure."
                imagePath="/illustrations/collaboration.webp"
                imageAlt="Dedicated Support"
                imageHeight="h-[285px]"
              />
            </div>
          </div>
        </div>
        <div className="px-5 mb-32 md:mb-40">
          <CommercialGetStarted />
        </div>
      </div>
    </>
  );
};
