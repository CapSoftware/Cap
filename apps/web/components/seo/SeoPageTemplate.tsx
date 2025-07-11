"use client";

import { SeoPageContent } from "@/components/seo/types";
import { Button } from "@cap/ui";
import MuxPlayer from "@mux/mux-player-react";
import { motion } from "framer-motion";
import { useEffect } from "react";

const renderHTML = (content: string) => {
  const styledContent = content.replace(
    /<a\s/g,
    '<a class="font-semibold text-blue-500 hover:text-blue-600 transition-colors" '
  );

  return <span dangerouslySetInnerHTML={{ __html: styledContent }} />;
};

// Left Blue Hue Component
const LeftBlueHue = () => {
  return (
    <svg
      className="absolute top-10 -left-24 z-0 opacity-20 pointer-events-none md:opacity-100"
      width="1276"
      height="690"
      viewBox="0 0 1276 690"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g filter="url(#blue-hue-filter)">
        <ellipse
          cx="592"
          cy="339"
          rx="584"
          ry="251"
          transform="rotate(180 592 339)"
          fill="url(#blue-hue-gradient)"
        />
      </g>
      <defs>
        <filter
          id="blue-hue-filter"
          x="-92"
          y="-12"
          width="1368"
          height="702"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend
            mode="normal"
            in="SourceGraphic"
            in2="BackgroundImageFix"
            result="shape"
          />
          <feGaussianBlur stdDeviation="50" result="blur-effect" />
        </filter>
        <linearGradient
          id="blue-hue-gradient"
          x1="1102.5"
          y1="339"
          x2="157.5"
          y2="375.5"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#75A3FE" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
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
      const cloud4 = document.getElementById("cloud-4");
      const cloud5 = document.getElementById("cloud-5");

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

    animateClouds();
  }, []);

  return (
    <>
      <div
        className="relative overflow-hidden mt-[60px]"
        style={{ height: "calc(100vh - 60px)" }}
      >
        <div className="relative z-10 px-5 w-full h-full flex flex-col justify-center">
          <div className="mx-auto text-center wrapper wrapper-sm">
            <h1 className="fade-in-down text-[2.25rem] leading-[2.75rem] md:text-[3.5rem] md:leading-[4rem] relative z-10 text-black mb-6">
              {content.title}
            </h1>
            <p className="mx-auto mb-10 max-w-2xl text-md sm:text-xl text-zinc-500 fade-in-down animate-delay-1">
              {content.description}
            </p>
          </div>
          <div className="flex flex-col justify-center items-center space-y-2 fade-in-up animate-delay-2 sm:flex-row sm:space-y-0 sm:space-x-4">
            <Button
              variant="blue"
              href="/download"
              size="lg"
              className="relative z-[20] w-full font-medium text-md sm:w-auto"
            >
              {content.cta.buttonText}
            </Button>
          </div>
        </div>

        {/** Header BG */}
        <div className="w-full mx-auto overflow-hidden h-[830px] absolute top-0 left-0 z-0">
          <motion.div
            animate={{
              x: [0, "30vw"],
              top: 340,
              opacity: [0.7, 0.5],
            }}
            transition={{
              duration: 6,
              repeat: Infinity,
              repeatType: "reverse",
              ease: "linear",
            }}
            className="absolute opacity-70 top-[340px] -left-[200px] z-[9]
            w-full max-w-[1800px] h-[100px] bg-gradient-to-l from-transparent via-white/90 to-white"
            style={{
              borderRadius: "100%",
              mixBlendMode: "plus-lighter",
              filter: "blur(50px)",
            }}
          />
          <motion.div
            initial={{
              right: -200,
              top: 150,
              opacity: 0.25,
            }}
            animate={{
              right: [-200, 400],
              opacity: [0.25, 0.1, 0.25],
            }}
            transition={{
              duration: 6,
              repeat: Infinity,
              repeatType: "reverse",
              ease: "linear",
            }}
            className="absolute mix-blend-plus-lighter z-[9] w-full max-w-[800px] h-[200px]
            blur-[60px] rounded-full bg-gradient-to-r from-transparent via-white to-white"
          />

          <LeftBlueHue />

          {/** Clouds - Exactly matching HomePage */}
          <motion.img
            style={{
              mixBlendMode: "plus-lighter",
            }}
            initial={{
              right: 100,
              top: 50,
              rotate: 180,
            }}
            animate={{
              x: "-100vw",
            }}
            transition={{
              duration: 500,
              repeat: Infinity,
              repeatType: "reverse",
              ease: "linear",
            }}
            className="absolute w-full max-w-[500px] z-[5] select-none"
            src="/illustrations/bottomcloud.webp"
            alt="bottomcloudthree"
          />
          <motion.img
            style={{
              mixBlendMode: "plus-lighter",
            }}
            animate={{
              x: [0, "100vw"],
            }}
            transition={{
              duration: 300,
              repeat: Infinity,
              repeatType: "reverse",
            }}
            className="absolute
            top-[180px] w-full max-w-[280px] z-[4] right-[60px] md:right-[600px] select-none"
            src="/illustrations/smallcloudthree.webp"
            alt="smallcloudfour"
          />
          <motion.img
            style={{
              mixBlendMode: "screen",
            }}
            animate={{
              x: [0, "100vw"],
            }}
            transition={{
              duration: 100,
              repeat: Infinity,
              repeatType: "reverse",
              ease: "linear",
            }}
            className="absolute top-[20px] left-[-60px] md:left-[-400px] select-none z-[5] pointer-events-none"
            src="/illustrations/bottomcloud.webp"
            alt="bottomcloudthree"
          />
          <img
            className="absolute
            top-[180px] w-full max-w-[400px] z-0 select-none right-[60px] opacity-30 pointer-events-none"
            src="/illustrations/smallcloudthree.webp"
            alt="smallcloudthree"
          />
          <motion.img
            style={{
              mixBlendMode: "screen",
            }}
            animate={{
              x: [0, "-100vw"],
            }}
            transition={{
              duration: 120,
              repeat: Infinity,
              repeatType: "reverse",
              ease: "linear",
            }}
            className="absolute
            bottom-[240px] w-full max-w-[430px] z-[1] right-[40px] select-none opacity-80 brightness-125 pointer-events-none"
            src="/illustrations/smallcloudtwo.webp"
            alt="smallcloudtwo"
          />
          <img
            style={{
              mixBlendMode: "screen",
            }}
            className="absolute
            w-full max-w-[500px] top-[210px] right-[300px] z-[2] select-none brightness-125 pointer-events-none"
            src="/illustrations/chipcloud.webp"
            alt="chipcloudtwo"
          />
          <motion.img
            style={{
              mixBlendMode: "screen",
            }}
            initial={{
              x: -200,
              rotate: 180,
            }}
            animate={{
              x: [-200, "100vw"],
            }}
            transition={{
              duration: 200,
              repeat: Infinity,
              repeatType: "reverse",
              ease: "linear",
            }}
            className="absolute
            w-full max-w-[500px] bottom-[15px] select-none left-[-200px] lg:left-[30px] z-[10] pointer-events-none"
            src="/illustrations/chipcloud.webp"
            alt="chipcloudfour"
          />
          <img
            className="absolute
            w-full max-w-[500px] top-[160px] select-none mix-blend-screen left-[-200px] lg:left-[30px] z-[10] pointer-events-none"
            src="/illustrations/chipcloud.webp"
            alt="chipcloud"
          />
          <img
            className="absolute bottom-[-200px] -left-[500px] select-none z-[5] pointer-events-none"
            src="/illustrations/bottomcloud.webp"
            alt="bottomcloud"
          />
          <img
            className="absolute bottom-[-90px] right-[-400px] select-none z-[5] pointer-events-none"
            src="/illustrations/bottomcloud.webp"
            alt="bottomcloudtwo"
          />
        </div>

        {/** Right Blue Hue */}
        <div
          className="w-[868px] h-[502px] bg-gradient-to-l rounded-full blur-[100px]
          absolute top-20 z-[0] right-0 from-[#A6D7FF] to-transparent"
        />
      </div>

      {/* Main Content */}
      <div className="wrapper py-24 bg-gradient-to-b from-white to-gray-50 relative z-10">
        {/* Features Section */}
        <div className="mb-28">
          <div className="text-center max-w-[800px] mx-auto mb-16">
            <h2 className="text-4xl font-medium text-gray-800 mb-6 relative inline-block">
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
                className="p-8 bg-gray-1 rounded-2xl shadow-md hover:shadow-xl transition-all duration-300 border border-gray-100 hover:border-blue-100 transform hover:-translate-y-1"
              >
                <div className="bg-blue-50 w-12 h-12 flex items-center justify-center rounded-full mb-4">
                  <span className="text-blue-500 text-xl font-medium">
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

        {/* Video Demonstration */}
        {showVideo && (
          <div className="mb-28">
            <div className="text-center max-w-[800px] mx-auto mb-10">
              <h2 className="text-4xl font-medium text-gray-800 mb-6 relative inline-block">
                See Cap In Action
                <span className="absolute -bottom-2 left-1/2 transform -translate-x-1/2 w-20 h-1 bg-blue-500 rounded-full"></span>
              </h2>
              <p className="text-xl text-gray-600 leading-relaxed">
                Watch how Cap makes screen recording simple, powerful, and
                accessible.
              </p>
            </div>
            <div className="max-w-2xl mx-auto">
              <div className="rounded-xl overflow-hidden shadow-lg">
                <MuxPlayer
                  playbackId="A6oZoUWVZjOIVZB6XnBMLagYnXE6xhDhp8Hcyky018hk"
                  metadataVideoTitle="Cap Demo"
                  accentColor="#5C9FFF"
                  style={{ aspectRatio: "16/9", width: "100%" }}
                />
              </div>
            </div>
          </div>
        )}

        {/* Comparison Section */}
        {content.comparison && content.comparisonTitle && (
          <div className="mb-28">
            <div className="text-center max-w-[800px] mx-auto mb-16">
              <h2 className="text-4xl font-medium text-gray-800 mb-6 relative inline-block">
                {content.comparisonTitle}
                <span className="absolute -bottom-2 left-1/2 transform -translate-x-1/2 w-20 h-1 bg-blue-500 rounded-full"></span>
              </h2>
              {content.comparisonDescription && (
                <p className="text-xl text-gray-600 leading-relaxed">
                  {renderHTML(content.comparisonDescription)}
                </p>
              )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              {content.comparison.map((item, index) => (
                <div
                  key={index}
                  className="p-8 bg-gray-1 rounded-2xl shadow-md hover:shadow-xl transition-all duration-300 border border-gray-100 hover:border-blue-100 transform hover:-translate-y-1"
                >
                  <div className="bg-indigo-50 w-12 h-12 flex items-center justify-center rounded-full mb-4">
                    <span className="text-indigo-500 text-xl font-medium">
                      {index + 1}
                    </span>
                  </div>
                  <h3 className="text-xl mb-4 text-gray-800 font-semibold">
                    {item.title}
                  </h3>
                  <p className="text-gray-600 leading-relaxed">
                    {renderHTML(item.description)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recording Modes Section */}
        {content.recordingModes && (
          <div className="mb-28">
            <div className="text-center max-w-[800px] mx-auto mb-16">
              <h2 className="text-4xl font-medium text-gray-800 mb-6 relative inline-block">
                {content.recordingModes.title}
                <span className="absolute -bottom-2 left-1/2 transform -translate-x-1/2 w-20 h-1 bg-blue-500 rounded-full"></span>
              </h2>
              <p className="text-xl text-gray-600 leading-relaxed">
                {renderHTML(content.recordingModes.description)}
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl mx-auto">
              {content.recordingModes.modes.map((mode, index) => (
                <div
                  key={index}
                  className="p-8 bg-blue-50/50 rounded-2xl shadow-md hover:shadow-xl transition-all duration-300 border border-blue-100/20 transform hover:-translate-y-1"
                >
                  <div className="bg-blue-500 w-12 h-12 flex items-center justify-center rounded-full mb-4">
                    <span className="text-white text-xl font-medium">
                      {index + 1}
                    </span>
                  </div>
                  <h3 className="text-xl mb-4 text-blue-700 font-semibold">
                    {mode.title}
                  </h3>
                  <p className="text-gray-600 leading-relaxed">
                    {renderHTML(mode.description)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Comparison Table Section */}
        {content.comparisonTable && (
          <div className="mb-28">
            <div className="text-center max-w-[800px] mx-auto mb-16">
              <h2 className="text-4xl font-medium text-gray-800 mb-6 relative inline-block">
                {content.comparisonTable.title}
                <span className="absolute -bottom-2 left-1/2 transform -translate-x-1/2 w-20 h-1 bg-blue-500 rounded-full"></span>
              </h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full max-w-4xl mx-auto bg-gray-1 rounded-xl shadow-md">
                <thead className="bg-blue-50">
                  <tr>
                    {content.comparisonTable.headers.map((header, index) => (
                      <th
                        key={index}
                        className="py-4 px-6 text-left text-gray-700 font-semibold border-b border-gray-200"
                      >
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {content.comparisonTable.rows.map((row, rowIndex) => (
                    <tr
                      key={rowIndex}
                      className={
                        rowIndex % 2 === 0 ? "bg-gray-1" : "bg-gray-50"
                      }
                    >
                      {row.map((cell, cellIndex) => (
                        <td
                          key={cellIndex}
                          className="py-4 px-6 border-b border-gray-200"
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Use Cases Section */}
        <div className="mb-28">
          <div className="text-center max-w-[800px] mx-auto mb-16">
            <h2 className="text-4xl font-medium text-gray-800 mb-6 relative inline-block">
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
                className="p-8 bg-gray-1 rounded-2xl shadow-md hover:shadow-xl transition-all duration-300 border border-gray-100 hover:border-blue-100 transform hover:-translate-y-1"
              >
                <div className="bg-blue-50 w-12 h-12 flex items-center justify-center rounded-full mb-4">
                  <span className="text-blue-500 text-xl font-medium">
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

        {/* Testimonials Section */}
        {content.testimonials && (
          <div className="mb-28">
            <div className="text-center max-w-[800px] mx-auto mb-16">
              <h2 className="text-4xl font-medium text-gray-800 mb-6 relative inline-block">
                {content.testimonials.title}
                <span className="absolute -bottom-2 left-1/2 transform -translate-x-1/2 w-20 h-1 bg-blue-500 rounded-full"></span>
              </h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
              {content.testimonials.items.map((testimonial, index) => (
                <div
                  key={index}
                  className="p-8 bg-gray-1 rounded-2xl shadow-md hover:shadow-xl transition-all duration-300 border border-gray-100"
                >
                  <div className="mb-4 text-blue-500">
                    <svg
                      className="w-10 h-10"
                      fill="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path d="M3.691 6.292C5.094 4.771 7.217 4 10.066 4h.141c.297 0 .54.24.54.531v5.297c0 .297-.243.531-.54.531h-3.908c-.297 0-.54.244-.54.543v3.2c0 1.793 1.464 3.2 3.277 3.2h.544c.296 0 .54.234.54.531v5.297c0 .297-.244.531-.54.531h-.544c-5.847 0-10-4.153-10-10v-6.4c0-.936.174-1.791.594-2.569zm16 0C21.094 4.771 23.217 4 26.066 4h.141c.297 0 .54.24.54.531v5.297c0 .297-.243.531-.54.531h-3.908c-.297 0-.54.244-.54.543v3.2c0 1.793 1.464 3.2 3.277 3.2h.544c.296 0 .54.234.54.531v5.297c0 .297-.244.531-.54.531h-.544c-5.847 0-10-4.153-10-10v-6.4c0-.936.174-1.791.594-2.569z"></path>
                    </svg>
                  </div>
                  <p className="text-gray-700 italic mb-4 leading-relaxed">
                    "{testimonial.quote}"
                  </p>
                  <p className="text-gray-600 font-semibold">
                    {testimonial.author}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Migration Guide Section */}
        {content.migrationGuide && (
          <div className="mb-28">
            <div className="text-center max-w-[800px] mx-auto mb-16">
              <h2 className="text-4xl font-medium text-gray-800 mb-6 relative inline-block">
                {content.migrationGuide.title}
                <span className="absolute -bottom-2 left-1/2 transform -translate-x-1/2 w-20 h-1 bg-blue-500 rounded-full"></span>
              </h2>
            </div>
            <div className="max-w-3xl mx-auto bg-gray-1 p-8 rounded-2xl shadow-md">
              <ol className="list-none">
                {content.migrationGuide.steps.map((step, index) => (
                  <li key={index} className="mb-6 flex items-start">
                    <div className="bg-blue-500 text-white rounded-full w-8 h-8 flex items-center justify-center mr-4 flex-shrink-0 mt-1">
                      {index + 1}
                    </div>
                    <p className="text-gray-700 mt-1">{step}</p>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        )}

        {/* FAQ Section */}
        <div className="mb-28">
          <div className="text-center max-w-[800px] mx-auto mb-16">
            <h2 className="text-4xl font-medium text-gray-800 mb-6 relative inline-block">
              {content.faqsTitle}
              <span className="absolute -bottom-2 left-1/2 transform -translate-x-1/2 w-20 h-1 bg-blue-500 rounded-full"></span>
            </h2>
          </div>
          <div className="mb-10 max-w-3xl mx-auto">
            {content.faqs.map((faq, index) => (
              <div
                key={index}
                className="my-6 p-6 bg-gray-1 rounded-xl shadow-sm hover:shadow-md transition-all duration-300 border border-gray-100"
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
          className="wrapper max-w-[1000px] mx-auto rounded-3xl overflow-hidden relative flex flex-col justify-center p-12"
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
              <h2 className="text-3xl md:text-4xl font-medium text-white mb-4 drop-shadow-md">
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
                className="w-full sm:w-auto transition-all duration-300 font-medium px-8 py-3"
              >
                {content.cta.buttonText}
              </Button>
            </div>
          </div>
        </div>
      </div>

      <style jsx global>{`
        @keyframes fade-in-down {
          0% {
            opacity: 0;
            transform: translateY(-10px);
          }
          100% {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes fade-in-up {
          0% {
            opacity: 0;
            transform: translateY(10px);
          }
          100% {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .fade-in-down {
          animation: fade-in-down 0.8s ease-out forwards;
        }

        .fade-in-up {
          animation: fade-in-up 0.8s ease-out forwards;
        }

        .animate-delay-1 {
          animation-delay: 0.1s;
        }

        .animate-delay-2 {
          animation-delay: 0.2s;
        }
      `}</style>
    </>
  );
};
