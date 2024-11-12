"use client";

import { Button } from "@cap/ui";
import { SeoPageContent } from "@/components/seo/types";
import { useEffect } from "react";

export const SeoPageTemplate = ({
  content,
  showVideo = true,
}: {
  content: SeoPageContent;
  showVideo?: boolean;
}) => {
  useEffect(() => {
    const animateClouds = () => {
      const cloud1 = document.getElementById("cloud-1");
      const cloud2 = document.getElementById("cloud-2");
      const cloud3 = document.getElementById("cloud-3");

      if (cloud1 && cloud2 && cloud3) {
        cloud1.animate(
          [
            { transform: "translateX(200px)" },
            { transform: "translateX(-50px)" },
            { transform: "translateX(0)" },
          ],
          {
            duration: 100000,
            iterations: Infinity,
          }
        );

        cloud2.animate(
          [
            { transform: "translateX(-200px)" },
            { transform: "translateX(50px)" },
            { transform: "translateX(0)" },
          ],
          {
            duration: 120000,
            iterations: Infinity,
          }
        );

        cloud3.animate(
          [
            { transform: "translateY(100px)" },
            { transform: "translateY(-30px)" },
            { transform: "translateY(0)" },
          ],
          {
            duration: 150000,
            iterations: Infinity,
          }
        );
      }
    };

    animateClouds();
  }, []);

  return (
    <>
      {/* Hero Section with Clouds */}
      <div className="-mt-[80px] bg-blue-500/40 min-h-screen md:min-h-[calc(100vh+20px)] relative flex items-center overflow-hidden">
        <div className="w-full relative z-10 flex">
          <div className="wrapper wrapper-sm mx-auto flex items-center">
            <div className="mb-auto text-center">
              <h1 className="fade-in-down text-[2rem] leading-[2.5rem] md:text-[3rem] md:leading-[3.5rem] relative z-10 mb-4">
                {content.title}
              </h1>
              <p className="fade-in-down animate-delay-1 text-black/60 sm:text-lg max-w-2xl mx-auto mb-8">
                {content.description}
              </p>
              <div className="fade-in-up animate-delay-2">
                <div className="flex flex-col sm:flex-row items-center justify-center space-y-2 sm:space-y-0 sm:space-x-2">
                  <Button variant="primary" href="/download" size="lg">
                    {content.cta.buttonText}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Clouds */}
        <div
          id="cloud-1"
          className="absolute top-0 -right-20 opacity-70 md:opacity-70 opacity-90"
        >
          <img
            className="max-w-[60vw] md:max-w-[40vw] h-auto"
            src="/illustrations/cloud-1.png"
            alt="Cloud Decoration One"
          />
        </div>
        <div
          id="cloud-2"
          className="absolute top-0 left-0 opacity-70 md:opacity-70 opacity-90"
        >
          <img
            className="max-w-[60vw] md:max-w-[40vw] h-auto"
            src="/illustrations/cloud-2.png"
            alt="Cloud Decoration Two"
          />
        </div>
        <div
          id="cloud-3"
          className="absolute -bottom-20 left-0 transform opacity-70 md:opacity-70 opacity-90"
        >
          <img
            className="max-w-[60vw] md:max-w-[100vw] h-auto"
            src="/illustrations/cloud-3.png"
            alt="Cloud Decoration Three"
          />
        </div>
      </div>

      {/* Main Content */}
      <div className="wrapper py-20">
        {/* Features Section */}
        <div className="mb-20">
          <div className="text-center max-w-[800px] mx-auto mb-12">
            <h2 className="text-3xl font-medium text-gray-500 mb-4">
              {content.featuresTitle}
            </h2>
            <p className="text-lg text-gray-600">
              {content.featuresDescription}
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {content.features.map((feature, index) => (
              <div key={index} className="p-6 bg-gray-100 rounded-xl">
                <h3 className="text-xl mb-3 text-gray-500 font-medium">
                  {feature.title}
                </h3>
                <p className="text-gray-600">{feature.description}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Use Cases Section */}
        <div className="mb-20">
          <div className="text-center max-w-[800px] mx-auto mb-12">
            <h2 className="text-3xl font-medium text-gray-500 mb-4">
              {content.useCasesTitle}
            </h2>
            <p className="text-lg text-gray-600">
              {content.useCasesDescription}
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {content.useCases.map((useCase, index) => (
              <div key={index} className="p-6 bg-gray-100 rounded-xl">
                <h3 className="text-xl mb-3 text-gray-500 font-medium">
                  {useCase.title}
                </h3>
                <p className="text-gray-600">{useCase.description}</p>
              </div>
            ))}
          </div>
        </div>

        {/* FAQ Section */}
        <div className="mb-20">
          <div className="text-center max-w-[800px] mx-auto mb-12">
            <h2 className="text-3xl font-medium text-gray-500 mb-4">
              {content.faqsTitle}
            </h2>
          </div>
          <div className="mb-10">
            {content.faqs.map((faq, index) => (
              <div key={index} className="max-w-2xl mx-auto my-8">
                <h2 className="text-xl text-gray-500 mb-2">{faq.question}</h2>
                <p className="text-lg">{faq.answer}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Final CTA Section */}
        <div
          className="wrapper custom-bg max-w-[1000px] mx-auto rounded-[20px] overflow-hidden relative flex flex-col justify-center p-8"
          style={{ minHeight: "264px" }}
        >
          <div
            id="cloud-4"
            className="absolute top-0 -right-20 opacity-50 z-0 pointer-events-none"
          >
            <img
              className="max-w-[40vw] h-auto"
              src="/illustrations/cloud-1.png"
              alt="Footer Cloud One"
            />
          </div>
          <div
            id="cloud-5"
            className="absolute bottom-0 left-0 opacity-50 z-0 pointer-events-none"
          >
            <img
              className="max-w-[40vw] h-auto"
              src="/illustrations/cloud-2.png"
              alt="Footer Cloud Two"
            />
          </div>
          <div className="wrapper mx-auto h-full flex flex-col justify-center items-center relative z-10">
            <div className="text-center max-w-[800px] mx-auto mb-5">
              <h2 className="text-white mb-3">{content.cta.title}</h2>
            </div>
            <div className="flex flex-col sm:flex-row items-center justify-center space-y-2 sm:space-y-0 sm:space-x-2">
              <Button
                variant="white"
                href="/pricing"
                size="lg"
                className="w-full sm:w-auto"
              >
                {content.cta.buttonText}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};
