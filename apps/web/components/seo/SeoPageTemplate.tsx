"use client";

import { SeoPageContent } from "@/components/seo/types";
import { Button } from "@cap/ui";
import MuxPlayer from "@mux/mux-player-react";


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
      </div>

      {/* Main Content */}
      <div className="wrapper py-24 relative z-10">
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
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 px-4">
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
              <table className="w-full max-w-4xl mx-auto bg-gray-1 shadow-md rounded-2xl overflow-hidden">
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
                      className={rowIndex % 2 === 0 ? "bg-gray-1" : "bg-gray-50"}
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
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 px-4">
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
          className="max-w-[1000px] mx-auto rounded-3xl overflow-hidden relative flex flex-col justify-center border border-gray-5 p-12 bg-white"
          style={{
            minHeight: "300px",
            backgroundImage: "url('/illustrations/ctabg.svg')",
            backgroundSize: "cover",
            backgroundRepeat: "no-repeat",
          }}
        >
          <div className="wrapper mx-auto h-full flex flex-col justify-center items-center relative z-10">
            <div className="text-center max-w-[800px] mx-auto mb-8">
              <h2 className="text-3xl md:text-4xl font-medium text-gray-12 mb-4 drop-shadow-md">
                {content.cta.title}
              </h2>
              <p className="text-xl text-gray-10 mb-6">
                Ready to get started? Download now and see the difference.
              </p>
            </div>
            <div className="flex flex-col sm:flex-row items-center justify-center space-y-3 sm:space-y-0 sm:space-x-4">
              <Button
                variant="blue"
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
