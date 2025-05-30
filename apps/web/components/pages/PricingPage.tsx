"use client";

import { getProPlanId } from "@cap/utils";
import { faHeart } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Testimonials } from "../ui/Testimonials";
import { CommercialCard, ProCard } from "./HomePage/Pricing";

const QuantityButton = ({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) => {
  return (
    <button
      onClick={onClick}
      className="flex justify-center items-center px-2 py-0 w-6 h-6 bg-gray-200 rounded-md hover:bg-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-400"
    >
      {children}
    </button>
  );
};

export const PricingPage = () => {
  const [proLoading, setProLoading] = useState(false);
  const [commercialLoading, setCommercialLoading] = useState(false);
  const [isAnnual, setIsAnnual] = useState(true);
  const [isCommercialAnnual, setIsCommercialAnnual] = useState(false);
  const [proQuantity, setProQuantity] = useState(1);
  const [licenseQuantity, setLicenseQuantity] = useState(1);
  const [initialRender, setInitialRender] = useState(true);
  const { push } = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const init = async () => {
      setInitialRender(false);
      const planFromUrl = searchParams.get("plan");
      const pendingPriceId = localStorage.getItem("pendingPriceId");
      const pendingProQuantity = localStorage.getItem("pendingQuantity");

      if (pendingPriceId && pendingProQuantity) {
        localStorage.removeItem("pendingPriceId");
        localStorage.removeItem("pendingQuantity");

        const response = await fetch(`/api/settings/billing/subscribe`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            priceId: pendingPriceId,
            quantity: parseInt(pendingProQuantity),
          }),
        });
        const data = await response.json();

        if (data.url) {
          window.location.href = data.url;
        }
      } else if (planFromUrl) {
        planCheckout(planFromUrl);
      }
    };

    init();
  }, []);

  const scrollToTestimonials = (e: React.MouseEvent) => {
    e.preventDefault();
    const testimonials = document.getElementById("testimonials");
    if (testimonials) {
      const offset = 80;
      const topPos =
        testimonials.getBoundingClientRect().top + window.pageYOffset - offset;
      window.scrollTo({
        top: topPos,
        behavior: "smooth",
      });
    }
  };

  const planCheckout = async (planId?: string) => {
    setProLoading(true);

    if (!planId) {
      planId = getProPlanId(isAnnual ? "yearly" : "monthly");
    }

    const response = await fetch(`/api/settings/billing/subscribe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ priceId: planId, quantity: proQuantity }),
    });
    const data = await response.json();

    if (data.auth === false) {
      localStorage.setItem("pendingPriceId", planId);
      localStorage.setItem("pendingQuantity", proQuantity.toString());
      push(`/login?next=/pricing`);
      return;
    }

    if (data.subscription === true) {
      toast.success("You are already on the Cap Pro plan");
    }

    if (data.url) {
      window.location.href = data.url;
    }

    setProLoading(false);
  };

  const openCommercialCheckout = async () => {
    setCommercialLoading(true);
    try {
      const response = await fetch(`/api/commercial/checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: isCommercialAnnual ? "yearly" : "lifetime",
          quantity: licenseQuantity,
        }),
      });

      const data = await response.json();

      if (response.status === 200) {
        window.location.href = data.url;
      } else {
        throw new Error(data.message);
      }
    } catch (error) {
      console.error("Error during commercial checkout:", error);
      toast.error("Failed to start checkout process");
    } finally {
      setCommercialLoading(false);
    }
  };

  const proList = [
    {
      text: "Connect your own domain to Cap",
      available: true,
    },
    {
      text: "Unlimited cloud storage & Shareable links",
      available: true,
    },
    {
      text: "Connect custom S3 storage bucket",
      available: true,
    },
    {
      text: "Desktop app commercial license included",
      available: true,
    },
    {
      text: "Advanced teams features",
      available: true,
    },
    {
      text: "Unlimited views",
      available: true,
    },
    {
      text: "Password protected videos",
      available: true,
    },
    {
      text: "Advanced analytics",
      available: true,
    },
    {
      text: "Priority support",
      available: true,
    },
  ];

  const commercialList = [
    {
      text: "Commercial Use of Cap Recorder + Editor",
      available: true,
    },
    {
      text: "Community Support",
      available: true,
    },
    {
      text: "Local-only features",
      available: true,
    },
    {
      text: "Perpetual license option",
      available: true,
    },
  ];

  return (
    <div>
      <div className="py-12 mt-16 space-y-24 wrapper">
        <div>
          <div className="mb-8 text-center">
            <h1
              className={clsx("text-4xl md:text-5xl", {
                "fade-in-down animate-delay-1 text-gray-12": initialRender,
              })}
            >
              Early Adopter Pricing
            </h1>
            <p
              className={clsx("mx-auto mt-3 max-w-[800px]", {
                "mt-4 fade-in-down animate-delay-1 text-gray-10": initialRender,
              })}
            >
              Cap is currently in public beta, and we're offering special early
              adopter pricing to our first users. This pricing will be locked in
              for the lifetime of your subscription.
            </p>
            <div
              onClick={scrollToTestimonials}
              className="flex justify-center cursor-pointer items-center px-5 py-2.5 gap-2 mx-auto mt-6 rounded-full border bg-gray-1 border-gray-5 w-fit"
            >
              <FontAwesomeIcon
                className="text-red-500 size-3.5"
                icon={faHeart}
              />
              <p className="font-medium text-gray-12">Loved by 10k+ users</p>
            </div>
          </div>

          <div className="flex flex-col w-full max-w-[1000px] mx-auto gap-8 justify-center items-stretch lg:flex-row">
            <CommercialCard />
            <ProCard />
          </div>
        </div>
        <div className="mb-32 wrapper" id="testimonials">
          <Testimonials
            amount={24}
            title="What our users say about Cap after hitting record"
            subtitle="Don't just take our word for it. Here's what our users are saying about their experience with Cap."
          />
        </div>
        <div>
          <img
            className="mx-auto w-full h-auto"
            src="/illustrations/comparison.png"
            alt="Cap vs Competitors Table"
          />
        </div>
      </div>
    </div>
  );
};
