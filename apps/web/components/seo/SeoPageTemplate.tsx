"use client";

import { Button } from "@cap/ui";
import { SeoPageContent } from "@/components/seo/types";
import { useEffect } from "react";

const renderHTML = (content: string) => {
  const styledContent = content.replace(
    /<a\s/g,
    '<a class="font-semibold text-blue-500 hover:text-blue-600 transition-colors" '
  );

  return <span dangerouslySetInnerHTML={{ __html: styledContent }} />;
};

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
      const cloud4 = document.getElementById("cloud-4");
      const cloud5 = document.getElementById("cloud-5");

      if (cloud1 && cloud2 && cloud3) {
        cloud1.animate(
          [
            { transform: "translateX(0) translateY(0)" },
            { transform: "translateX(-30px) translateY(10px)" },
            { transform: "translateX(30px) translateY(-10px)" },
            { transform: "translateX(0) translateY(0)" },
          ],
          {
            duration: 20000,
            iterations: Infinity,
            easing: "ease-in-out",
          }
        );

        cloud2.animate(
          [
            { transform: "translateX(0) translateY(0)" },
            { transform: "translateX(20px) translateY(-15px)" },
            { transform: "translateX(-20px) translateY(15px)" },
            { transform: "translateX(0) translateY(0)" },
          ],
          {
            duration: 25000,
            iterations: Infinity,
            easing: "ease-in-out",
          }
        );

        cloud3.animate(
          [
            { transform: "translateX(0) translateY(0)" },
            { transform: "translateX(15px) translateY(20px)" },
            { transform: "translateX(-15px) translateY(-20px)" },
            { transform: "translateX(0) translateY(0)" },
          ],
          {
            duration: 30000,
            iterations: Infinity,
            easing: "ease-in-out",
          }
        );
      }

      if (cloud4 && cloud5) {
        cloud4.animate(
          [
            { transform: "translateX(0) translateY(0)" },
            { transform: "translateX(-10px) translateY(5px)" },
            { transform: "translateX(10px) translateY(-5px)" },
            { transform: "translateX(0) translateY(0)" },
          ],
          {
            duration: 15000,
            iterations: Infinity,
            easing: "ease-in-out",
          }
        );

        cloud5.animate(
          [
            { transform: "translateX(0) translateY(0)" },
            { transform: "translateX(10px) translateY(-5px)" },
            { transform: "translateX(-10px) translateY(5px)" },
            { transform: "translateX(0) translateY(0)" },
          ],
          {
            duration: 18000,
            iterations: Infinity,
            easing: "ease-in-out",
          }
        );
      }
    };

    // Add scroll reveal animations
    const observerOptions = {
      root: null,
      rootMargin: "0px",
      threshold: 0.1,
    };

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("animate-fade-in");
          observer.unobserve(entry.target);
        }
      });
    }, observerOptions);

    document.querySelectorAll(".reveal-on-scroll").forEach((el) => {
      observer.observe(el);
    });

    animateClouds();

    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <>
      {/* Hero Section with Clouds */}
      <div className="-mt-[80px] bg-gradient-to-b from-blue-400/30 via-blue-500/40 to-blue-600/30 min-h-screen md:min-h-[calc(100vh+20px)] relative flex items-center overflow-hidden">
        <div className="w-full relative z-10 flex">
          <div className="wrapper wrapper-sm mx-auto flex items-center">
            <div className="mb-auto text-center">
              <h1 className="fade-in-down text-[2.25rem] leading-[2.75rem] md:text-[3.5rem] md:leading-[4rem] font-bold relative z-10 mb-6 text-gray-800 drop-shadow-sm">
                {content.title}
              </h1>
              <p className="fade-in-down animate-delay-1 text-black/70 sm:text-xl max-w-2xl mx-auto mb-10 leading-relaxed">
                {content.description}
              </p>
              <div className="fade-in-up animate-delay-2">
                <div className="flex flex-col sm:flex-row items-center justify-center space-y-2 sm:space-y-0 sm:space-x-4">
                  <Button
                    variant="primary"
                    href="/download"
                    size="lg"
                    className="shadow-lg hover:shadow-xl transform hover:-translate-y-1 transition-all duration-300 px-8 py-3"
                  >
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
          className="absolute top-0 -right-20 opacity-80 transition-transform duration-700 ease-in-out"
        >
          <img
            className="max-w-[60vw] md:max-w-[40vw] h-auto"
            src="/illustrations/cloud-1.png"
            alt="Cloud Decoration One"
          />
        </div>
        <div
          id="cloud-2"
          className="absolute top-0 left-0 opacity-80 transition-transform duration-700 ease-in-out"
        >
          <img
            className="max-w-[60vw] md:max-w-[40vw] h-auto"
            src="/illustrations/cloud-2.png"
            alt="Cloud Decoration Two"
          />
        </div>
        <div
          id="cloud-3"
          className="absolute -bottom-20 left-0 opacity-80 transition-transform duration-700 ease-in-out"
        >
          <img
            className="max-w-[60vw] md:max-w-[100vw] h-auto"
            src="/illustrations/cloud-3.png"
            alt="Cloud Decoration Three"
          />
        </div>
      </div>

      {/* Main Content */}
      <div className="wrapper py-24 bg-gradient-to-b from-white to-gray-50">
        {/* Features Section */}
        <div className="mb-28 reveal-on-scroll opacity-0">
          <div className="text-center max-w-[800px] mx-auto mb-16">
            <h2 className="text-4xl font-bold text-gray-800 mb-6 relative inline-block">
              {content.featuresTitle}
              <span className="absolute -bottom-2 left-1/2 transform -translate-x-1/2 w-20 h-1 bg-blue-500 rounded-full"></span>
            </h2>
            <p className="text-xl text-gray-600 leading-relaxed">
              {renderHTML(content.featuresDescription)}
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {content.features.map((feature, index) => (
              <div
                key={index}
                className="p-8 bg-white rounded-2xl shadow-md hover:shadow-xl transition-all duration-300 border border-gray-100 hover:border-blue-100 transform hover:-translate-y-1"
              >
                <div className="bg-blue-50 w-12 h-12 flex items-center justify-center rounded-full mb-4">
                  <span className="text-blue-500 text-xl font-bold">
                    {index + 1}
                  </span>
                </div>
                <h3 className="text-xl mb-4 text-gray-800 font-semibold">
                  {feature.title}
                </h3>
                <p className="text-gray-600 leading-relaxed">
                  {renderHTML(feature.description)}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* Use Cases Section */}
        <div className="mb-28 reveal-on-scroll opacity-0">
          <div className="text-center max-w-[800px] mx-auto mb-16">
            <h2 className="text-4xl font-bold text-gray-800 mb-6 relative inline-block">
              {content.useCasesTitle}
              <span className="absolute -bottom-2 left-1/2 transform -translate-x-1/2 w-20 h-1 bg-blue-500 rounded-full"></span>
            </h2>
            <p className="text-xl text-gray-600 leading-relaxed">
              {renderHTML(content.useCasesDescription)}
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {content.useCases.map((useCase, index) => (
              <div
                key={index}
                className="p-8 bg-white rounded-2xl shadow-md hover:shadow-xl transition-all duration-300 border border-gray-100 hover:border-blue-100 transform hover:-translate-y-1"
              >
                <div className="bg-blue-50 w-12 h-12 flex items-center justify-center rounded-full mb-4">
                  <span className="text-blue-500 text-xl font-bold">
                    {String.fromCharCode(65 + index)}
                  </span>
                </div>
                <h3 className="text-xl mb-4 text-gray-800 font-semibold">
                  {useCase.title}
                </h3>
                <p className="text-gray-600 leading-relaxed">
                  {renderHTML(useCase.description)}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* FAQ Section */}
        <div className="mb-28 reveal-on-scroll opacity-0">
          <div className="text-center max-w-[800px] mx-auto mb-16">
            <h2 className="text-4xl font-bold text-gray-800 mb-6 relative inline-block">
              {content.faqsTitle}
              <span className="absolute -bottom-2 left-1/2 transform -translate-x-1/2 w-20 h-1 bg-blue-500 rounded-full"></span>
            </h2>
          </div>
          <div className="mb-10 max-w-3xl mx-auto">
            {content.faqs.map((faq, index) => (
              <div
                key={index}
                className="my-6 p-6 bg-white rounded-xl shadow-sm hover:shadow-md transition-all duration-300 border border-gray-100"
              >
                <h2 className="text-xl text-gray-800 font-semibold mb-3">
                  {faq.question}
                </h2>
                <div className="text-gray-600 leading-relaxed">
                  {renderHTML(faq.answer)}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Final CTA Section */}
        <div
          className="wrapper max-w-[1000px] mx-auto rounded-3xl overflow-hidden relative flex flex-col justify-center p-12 reveal-on-scroll opacity-0"
          style={{
            minHeight: "300px",
            background:
              "linear-gradient(135deg, #4f46e5 0%, #3b82f6 50%, #0ea5e9 100%)",
          }}
        >
          <div
            id="cloud-4"
            className="absolute top-0 -right-20 opacity-30 z-0 pointer-events-none transition-transform duration-700 ease-in-out"
          >
            <img
              className="max-w-[40vw] h-auto"
              src="/illustrations/cloud-1.png"
              alt="Footer Cloud One"
            />
          </div>
          <div
            id="cloud-5"
            className="absolute bottom-0 left-0 opacity-30 z-0 pointer-events-none transition-transform duration-700 ease-in-out"
          >
            <img
              className="max-w-[40vw] h-auto"
              src="/illustrations/cloud-2.png"
              alt="Footer Cloud Two"
            />
          </div>
          <div className="wrapper mx-auto h-full flex flex-col justify-center items-center relative z-10">
            <div className="text-center max-w-[800px] mx-auto mb-8">
              <h2 className="text-3xl md:text-4xl font-bold text-white mb-4 drop-shadow-md">
                {content.cta.title}
              </h2>
              <p className="text-xl text-white/90 mb-6">
                Ready to get started? Download now and see the difference.
              </p>
            </div>
            <div className="flex flex-col sm:flex-row items-center justify-center space-y-3 sm:space-y-0 sm:space-x-4">
              <Button
                variant="white"
                href="/pricing"
                size="lg"
                className="w-full sm:w-auto shadow-lg hover:shadow-xl transform hover:-translate-y-1 transition-all duration-300 font-medium px-8 py-3"
              >
                {content.cta.buttonText}
              </Button>
            </div>
          </div>
        </div>
      </div>

      <style jsx global>{`
        @keyframes fade-in {
          0% {
            opacity: 0;
            transform: translateY(20px);
          }
          100% {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .animate-fade-in {
          animation: fade-in 0.8s ease-out forwards;
        }
      `}</style>
    </>
  );
};
