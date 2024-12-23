"use client";

import { Button } from "@cap/ui";
import Link from "next/link";
import { format, parseISO } from "date-fns";
import { getCareerPosts, type CareerPost } from "@/utils";
import { useEffect, useState } from "react";

const values = [
  {
    title: "Remote First",
    description:
      "Work from anywhere in the world. We believe in hiring the best talent, regardless of location.",
  },
  {
    title: "Open Source",
    description:
      "We're building in public, with a strong focus on transparency and community collaboration.",
  },
  {
    title: "Innovation",
    description:
      "We're pushing the boundaries of what's possible in screen recording and sharing.",
  },
  {
    title: "Quality",
    description:
      "From our interface design to our code, we strive to build software that will last.",
  },
];

const benefits = [
  {
    title: "Competitive Salary",
    description:
      "We want the best, and will pay for the best. If you shine through we'll make sure you're paid what you're worth.",
    icon: "$",
    variant: "salary",
  },
  {
    title: "Stock Options",
    description:
      "As an early employee, you deserve to own a piece of our company. Stock options will be offered as part of your onboarding process.",
    icon: "📈",
    variant: "stock",
  },
  {
    title: "Paid Time Off",
    description:
      "Rest is important, you deliver your best work when you've had your downtime. We offer 4 weeks paid time off per year, and if you need more, we'll give you more.",
    icon: "😊",
    variant: "pto",
  },
  {
    title: "Work From Home",
    description:
      "As an open source project, we're remote first and intend to keep it that way. Sorry Elon.",
    icon: "🏠",
    variant: "remote",
  },
  {
    title: "Desk Budget",
    description:
      "Need an M1 MacBook Pro? We've got you covered. (You'll probably need one with Rust compile times)",
    icon: "💻",
    variant: "setup",
  },
  {
    title: "Health Care",
    description:
      "We use Deel for hiring and payroll, all your health care needs are covered.",
    icon: "❤️",
    variant: "health",
  },
];

export const CareersPage = () => {
  const [openPositions, setOpenPositions] = useState<CareerPost[]>([]);

  useEffect(() => {
    const fetchPosts = async () => {
      const posts = await getCareerPosts();
      setOpenPositions(
        posts.filter((position) => position.metadata.status === "Open")
      );
    };
    fetchPosts();
  }, []);

  return (
    <div className="careers-page">
      {/* Hero Section */}
      <div className="careers-hero">
        <div className="py-24 text-center relative z-10">
          <div className="wrapper wrapper-sm">
            <h1 className="text-5xl md:text-6xl font-bold mb-6 text-gray-900">
              Build the future of screen recording.
            </h1>
            <p className="text-xl text-gray-600 max-w-2xl mx-auto mb-12">
              Cap is redefining how we capture and share our screen, building an
              open ecosystem that makes screen recording and sharing accessible
              to everyone.
            </p>
            <Button href="#positions" size="lg" className="px-8 inline-flex">
              See Open Positions
            </Button>
          </div>
        </div>
      </div>

      {/* Values Section */}
      <section className="py-24">
        <div className="wrapper">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold mb-4 text-gray-900">
              Our Values
            </h2>
            <p className="text-gray-600">What drives us daily.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
            {values.map((value, index) => (
              <div key={index} className="value-card">
                <h3 className="text-xl font-semibold mb-3 text-gray-900">
                  {value.title}
                </h3>
                <p className="text-gray-600">{value.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Benefits Section */}
      <section className="py-24">
        <div className="wrapper">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold mb-4 text-gray-900">
              Perks and Benefits
            </h2>
            <p className="text-gray-600">We're behind you 100%.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {benefits.map((benefit, index) => (
              <div key={index} className={`benefit-card ${benefit.variant}`}>
                <div className="text-3xl mb-4">{benefit.icon}</div>
                <h3 className="text-xl font-semibold mb-3 text-gray-900">
                  {benefit.title}
                </h3>
                <p className="text-gray-600">{benefit.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Open Positions Section */}
      <section id="positions" className="py-24">
        <div className="wrapper wrapper-sm">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold mb-4 text-gray-900">
              Open Positions
            </h2>
            <p className="text-gray-600">Join us in our mission.</p>
          </div>

          <div className="space-y-4">
            {openPositions.length === 0 ? (
              <div className="text-center py-12 bg-white/50 backdrop-blur-sm rounded-xl border border-gray-200">
                <h3 className="text-xl font-semibold text-gray-900 mb-2">
                  No Open Positions Right Now
                </h3>
                <p className="text-gray-600">
                  While we don't have any open positions at the moment, we're
                  always interested in meeting talented people. Feel free to
                  reach out at{" "}
                  <a
                    href="mailto:careers@cap.so"
                    className="text-blue-600 hover:underline"
                  >
                    careers@cap.so
                  </a>
                </p>
              </div>
            ) : (
              openPositions.map((position) => (
                <Link
                  key={position.slug}
                  href={`/careers/${position.slug}`}
                  className="block"
                >
                  <div className="position-card group cursor-pointer">
                    <div className="flex justify-between items-start">
                      <div>
                        <h3 className="text-xl font-semibold mb-2 text-gray-900 group-hover:text-blue-600 transition-colors">
                          {position.metadata.title}
                        </h3>
                        <p className="text-gray-600 mb-4">
                          {position.metadata.description}
                        </p>
                        <div className="flex space-x-4 text-sm text-gray-500">
                          <span>{position.metadata.type}</span>
                          <span>•</span>
                          <span>{position.metadata.location}</span>
                          <span>•</span>
                          <span>
                            Posted{" "}
                            {format(
                              parseISO(position.metadata.publishedAt),
                              "MMMM d, yyyy"
                            )}
                          </span>
                        </div>
                      </div>
                      <div className="text-blue-600 group-hover:translate-x-1 transition-transform">
                        →
                      </div>
                    </div>
                  </div>
                </Link>
              ))
            )}
          </div>
        </div>
      </section>
    </div>
  );
};
