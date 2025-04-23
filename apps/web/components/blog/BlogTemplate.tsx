"use client";

import { Button } from "@cap/ui";
import Link from "next/link";
import { formatDate } from "../../lib/utils";
import { useEffect } from "react";
import MuxPlayer from "@mux/mux-player-react";

interface BlogPost {
  title: string;
  description: string;
  publishedAt: string;
  category: string;
  image?: string;
  author: string;
  tags: string[];
  heroTLDR: string;
  comparisonTable?: {
    title: string;
    headers: string[];
    rows: string[][];
  };
  methods?: {
    title: string;
    description: string;
    steps: {
      title?: string;
      content: string;
    }[];
  }[];
  troubleshooting?: {
    title: string;
    items: {
      question: string;
      answer: string;
    }[];
  };
  proTips?: {
    title: string;
    tips: {
      title: string;
      description: string;
    }[];
  };
  videoDemo?: {
    title: string;
    videoSrc: string;
    caption: string;
  };
  faqs?: {
    question: string;
    answer: string;
  }[];
  testimonial?: {
    quote: string;
    author: string;
    avatar: string;
  };
  cta: {
    title: string;
    description: string;
    buttonText: string;
    buttonLink: string;
    subtitle: string;
  };
  relatedLinks?: {
    text: string;
    url: string;
  }[];
}

const renderHTML = (content: string) => {
  const styledContent = content.replace(
    /<a\s/g,
    '<a class="font-semibold text-blue-500 hover:text-blue-600 transition-colors" '
  );

  return <div dangerouslySetInnerHTML={{ __html: styledContent }} />;
};

export const BlogTemplate = ({ content }: { content: BlogPost }) => {
  useEffect(() => {
    const animateClouds = () => {
      const cloud1 = document.getElementById("blog-cloud-1");
      const cloud2 = document.getElementById("blog-cloud-2");

      if (cloud1 && cloud2) {
        cloud1.animate(
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

        cloud2.animate(
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
    <article className="px-3 max-w-3xl mx-auto py-24 bg-gradient-to-b from-white to-gray-50 relative z-10">
      {/* Header */}
      <header className="mb-16 text-center">
        <div className="mb-4 text-sm font-medium text-blue-600 fade-in-down">
          {content.category}
        </div>
        <h1 className="text-4xl md:text-5xl font-bold text-gray-900 mb-6 fade-in-down">
          {content.title}
        </h1>
        <p className="text-xl md:text-2xl mb-8 max-w-3xl mx-auto text-gray-700 fade-in-down animate-delay-1">
          {content.description}
        </p>
        <div className="flex items-center justify-center space-x-2 text-sm text-gray-500 fade-in-down animate-delay-2">
          <time dateTime={content.publishedAt}>
            {formatDate(content.publishedAt)}
          </time>
          <span>•</span>
          <span>by {content.author}</span>
        </div>
      </header>

      {/* Featured Image */}
      {content.image && (
        <div className="mb-12 rounded-xl overflow-hidden shadow-xl transform hover:-translate-y-1 transition-all duration-300">
          <img
            src={content.image}
            alt={content.title}
            className="w-full h-auto object-cover"
          />
        </div>
      )}

      {/* Hero TL;DR */}
      <div className="mb-12 bg-blue-50 p-8 rounded-xl border border-blue-100 shadow-md hover:shadow-xl transition-all duration-300 transform hover:-translate-y-1">
        <h2 className="text-2xl font-bold text-gray-900 mb-4 relative inline-block">
          TL;DR
          <span className="absolute -bottom-1 left-0 w-16 h-1 bg-blue-500 rounded-full"></span>
        </h2>
        <p className="text-xl text-gray-700 mt-6">{content.heroTLDR}</p>
        <div className="mt-6 inline-flex">
          <Button
            href={content.cta.buttonLink}
            size="lg"
            variant="radialblue"
            className="px-6 py-3 shadow-lg hover:shadow-xl transform hover:-translate-y-1 transition-all duration-300"
          >
            {content.cta.buttonText}
          </Button>
        </div>
      </div>

      {/* Comparison Table */}
      {content.comparisonTable && (
        <section className="mb-16">
          <h2 className="text-3xl font-bold text-gray-900 mb-8 relative inline-block">
            {content.comparisonTable.title}
            <span className="absolute -bottom-2 left-1/2 transform -translate-x-1/2 w-20 h-1 bg-blue-500 rounded-full"></span>
          </h2>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse rounded-lg overflow-hidden shadow-md hover:shadow-lg transition-all duration-300">
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
                    className={rowIndex % 2 === 0 ? "bg-white" : "bg-gray-50"}
                  >
                    {row.map((cell, cellIndex) => (
                      <td
                        key={cellIndex}
                        className="py-4 px-6 border-b border-gray-200"
                        dangerouslySetInnerHTML={{ __html: cell }}
                      />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Methods */}
      {content.methods &&
        content.methods.map((method, index) => (
          <section key={index} className="mb-16">
            <h2 className="text-3xl font-bold text-gray-900 mb-6 relative inline-block">
              {method.title}
              <span className="absolute -bottom-2 left-1/2 transform -translate-x-1/2 w-20 h-1 bg-blue-500 rounded-full"></span>
            </h2>
            <p className="mb-8 text-xl text-gray-700">{method.description}</p>

            {method.steps.map((step, stepIndex) => (
              <div
                key={stepIndex}
                className="mb-8 p-6 bg-white rounded-xl shadow-md hover:shadow-xl transition-all duration-300 border border-gray-100 hover:border-blue-100 transform hover:-translate-y-1"
              >
                {step.title && (
                  <h3 className="text-2xl font-semibold text-gray-800 mb-4">
                    {step.title}
                  </h3>
                )}
                <div className="prose prose-lg max-w-none">
                  {renderHTML(step.content)}
                </div>
              </div>
            ))}
          </section>
        ))}

      {/* Troubleshooting */}
      {content.troubleshooting && (
        <section className="mb-16">
          <h2 className="text-3xl font-bold text-gray-900 mb-8 relative inline-block">
            {content.troubleshooting.title}
            <span className="absolute -bottom-2 left-1/2 transform -translate-x-1/2 w-20 h-1 bg-blue-500 rounded-full"></span>
          </h2>

          <div className="space-y-4">
            {content.troubleshooting.items.map((item, index) => (
              <details
                key={index}
                className="bg-white p-6 rounded-xl shadow-md hover:shadow-xl transition-all duration-300 border border-gray-100 hover:border-blue-100"
              >
                <summary className="text-xl font-semibold text-gray-800 cursor-pointer">
                  {item.question}
                </summary>
                <p className="mt-4 text-gray-700">{item.answer}</p>
              </details>
            ))}
          </div>
        </section>
      )}

      {/* Pro Tips */}
      {content.proTips && (
        <section className="mb-16">
          <h2 className="text-3xl font-bold text-gray-900 mb-8 relative inline-block">
            {content.proTips.title}
            <span className="absolute -bottom-2 left-1/2 transform -translate-x-1/2 w-20 h-1 bg-blue-500 rounded-full"></span>
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {content.proTips.tips.map((tip, index) => (
              <div
                key={index}
                className="bg-blue-50 p-6 rounded-xl border border-blue-100 shadow-md hover:shadow-xl transition-all duration-300 transform hover:-translate-y-1"
              >
                <h3 className="text-xl font-semibold text-blue-800 mb-3">
                  🔹 {tip.title}
                </h3>
                <p className="text-gray-700">{tip.description}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Video Demo */}
      {content.videoDemo && (
        <section className="mb-16">
          <h2 className="text-3xl font-bold text-gray-900 mb-6 relative inline-block">
            {content.videoDemo.title}
            <span className="absolute -bottom-2 left-1/2 transform -translate-x-1/2 w-20 h-1 bg-blue-500 rounded-full"></span>
          </h2>

          <figure className="rounded-xl overflow-hidden shadow-lg hover:shadow-xl transition-all duration-300 transform hover:-translate-y-1">
            <MuxPlayer
              playbackId="A6oZoUWVZjOIVZB6XnBMLagYnXE6xhDhp8Hcyky018hk"
              metadataVideoTitle="Cap Demo"
              accentColor="#5C9FFF"
              style={{ aspectRatio: "16/9", width: "100%" }}
            />
          </figure>
        </section>
      )}

      {/* FAQs */}
      {content.faqs && (
        <section className="mb-16">
          <h2 className="text-3xl font-bold text-gray-900 mb-8 relative inline-block">
            Frequently Asked Questions
            <span className="absolute -bottom-2 left-1/2 transform -translate-x-1/2 w-20 h-1 bg-blue-500 rounded-full"></span>
          </h2>

          <div className="space-y-4">
            {content.faqs.map((faq, index) => (
              <details
                key={index}
                className="bg-white p-6 rounded-xl shadow-md hover:shadow-xl transition-all duration-300 border border-gray-100 hover:border-blue-100"
              >
                <summary className="text-xl font-semibold text-gray-800 cursor-pointer">
                  {faq.question}
                </summary>
                <p className="mt-4 text-gray-700">{faq.answer}</p>
              </details>
            ))}
          </div>
        </section>
      )}

      {/* Testimonial */}
      {content.testimonial && (
        <section className="mb-16">
          <h2 className="text-3xl font-bold text-gray-900 mb-8 relative inline-block">
            What Users Are Saying
            <span className="absolute -bottom-2 left-1/2 transform -translate-x-1/2 w-20 h-1 bg-blue-500 rounded-full"></span>
          </h2>

          <blockquote className="bg-white p-8 rounded-xl shadow-md hover:shadow-xl transition-all duration-300 border-l-4 border-blue-500 transform hover:-translate-y-1">
            <p className="text-xl italic text-gray-700 mb-6">
              "{content.testimonial.quote}"
            </p>
            <footer className="flex items-center">
              <img
                src={content.testimonial.avatar}
                alt={content.testimonial.author}
                className="w-12 h-12 rounded-full mr-4"
              />
              <cite className="text-gray-900 font-medium not-italic">
                {content.testimonial.author}
              </cite>
            </footer>
          </blockquote>
        </section>
      )}

      {/* CTA Section */}
      <section className="mb-16">
        <div
          className="relative overflow-hidden p-10 rounded-2xl shadow-lg"
          style={{
            background:
              "linear-gradient(135deg, #4f46e5 0%, #3b82f6 50%, #0ea5e9 100%)",
          }}
        >
          <div
            id="blog-cloud-1"
            className="absolute top-0 -right-20 opacity-30 z-0 pointer-events-none transition-transform duration-700 ease-in-out"
          >
            <img
              className="max-w-[40vw] h-auto"
              src="/illustrations/cloud-1.png"
              alt="CTA Cloud One"
            />
          </div>
          <div
            id="blog-cloud-2"
            className="absolute bottom-0 left-0 opacity-30 z-0 pointer-events-none transition-transform duration-700 ease-in-out"
          >
            <img
              className="max-w-[40vw] h-auto"
              src="/illustrations/cloud-2.png"
              alt="CTA Cloud Two"
            />
          </div>
          <div className="relative z-10">
            <h2 className="text-3xl font-bold mb-4 text-white">
              {content.cta.title}
            </h2>
            <p className="text-xl mb-8 text-white/90">
              {content.cta.description}
            </p>
            <div className="inline-flex">
              <Button
                href={content.cta.buttonLink}
                variant="white"
                size="lg"
                className="px-8 py-3 text-blue-600 shadow-lg hover:shadow-xl transform hover:-translate-y-1 transition-all duration-300"
              >
                {content.cta.buttonText}
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* Related Links */}
      {content.relatedLinks && content.relatedLinks.length > 0 && (
        <div className="text-center text-gray-600 italic">
          Check out{" "}
          {(() => {
            const links = content.relatedLinks;
            return links.map((link, index) => (
              <span key={index}>
                <Link
                  href={link.url}
                  className="text-blue-600 hover:underline transition-colors"
                >
                  {link.text}
                </Link>
                {index < links.length - 1 ? " or " : ""}
              </span>
            ));
          })()}
          .
        </div>
      )}

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
    </article>
  );
};
