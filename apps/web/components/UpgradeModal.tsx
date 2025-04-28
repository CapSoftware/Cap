"use client";

import { Button, Dialog, DialogContent, DialogTitle, Switch } from "@cap/ui";
import { getProPlanId } from "@cap/utils";
import { useRive } from "@rive-app/react-canvas";
import { AnimatePresence, motion } from "framer-motion";
import {
  BarChart3,
  Database,
  Globe,
  Headphones,
  Infinity,
  Lock,
  Minus,
  Plus,
  Share2,
  Shield,
  Sparkles,
  Users,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import toast from "react-hot-toast";

interface UpgradeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const modalVariants = {
  hidden: {
    opacity: 0,
    scale: 0.95,
    y: 10,
  },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: {
      type: "spring",
      duration: 0.4,
      damping: 25,
      stiffness: 500,
    },
  },
  exit: {
    opacity: 0,
    scale: 0.95,
    y: 10,
    transition: {
      duration: 0.2,
    },
  },
};

export const UpgradeModal = ({ open, onOpenChange }: UpgradeModalProps) => {
  const [proLoading, setProLoading] = useState(false);
  const [isAnnual, setIsAnnual] = useState(true);
  const [proQuantity, setProQuantity] = useState(1);
  const { push } = useRouter();

  const pricePerUser = isAnnual ? 6 : 9;
  const totalPrice = pricePerUser * proQuantity;
  const billingText = isAnnual ? "billed annually" : "billed monthly";

  const { RiveComponent: Pro, rive: riveInstance } = useRive({
    src: "/rive/pricing.riv",
    artboard: "pro",
    animations: ["items-coming-out"],
    autoplay: true,
  });

  const handleProHover = () => {
    if (riveInstance) {
      riveInstance.play(["items-coming-out"]);
    }
  };

  const proFeatures = [
    {
      icon: <Globe className="w-8 h-8 text-blue-500" />,
      title: "Custom domain",
      description: "Connect your own domain to Cap",
    },
    {
      icon: <Share2 className="w-8 h-8 text-blue-500" />,
      title: "Unlimited sharing",
      description: "Cloud storage & shareable links",
    },
    {
      icon: <Database className="w-8 h-8 text-blue-500" />,
      title: "Custom storage",
      description: "Connect your own S3 bucket",
    },
    {
      icon: <Shield className="w-8 h-8 text-blue-500" />,
      title: "Commercial license",
      description: "Commercial license for desktop app automatically included",
    },
    {
      icon: <Users className="w-8 h-8 text-blue-500" />,
      title: "Team features",
      description: "Collaborate with your team and create shared spaces",
    },
    {
      icon: <Sparkles className="w-8 h-8 text-blue-500" />,
      title: "Cap AI (Coming Soon)",
      description: "Automatic video chapters, summaries & more",
    },
    {
      icon: <Infinity className="w-8 h-8 text-blue-500" />,
      title: "Unlimited views",
      description: "No limits on video views",
    },
    {
      icon: <Lock className="w-8 h-8 text-blue-500" />,
      title: "Password protected videos",
      description: "Enhanced security for your content",
    },
    {
      icon: <BarChart3 className="w-8 h-8 text-blue-500" />,
      title: "Analytics",
      description: "Video viewing insights",
    },
    {
      icon: <Headphones className="w-8 h-8 text-blue-500" />,
      title: "Priority support",
      description: "Get help when you need it",
    },
  ];

  const planCheckout = async () => {
    setProLoading(true);

    const planId = getProPlanId(isAnnual ? "yearly" : "monthly");

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
      push(`/login?next=/dashboard`);
      return;
    }

    if (data.subscription === true) {
      toast.success("You are already on the Cap Pro plan");
      onOpenChange(false);
    }

    if (data.url) {
      window.location.href = data.url;
    }

    setProLoading(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[650px] bg-gray-2 border border-gray-4 max-h-[90vh] overflow-y-auto p-6">
        <AnimatePresence mode="wait">
          {open && (
            <motion.div
              className="relative"
              variants={modalVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
            >
              <div className="sr-only">
                <DialogTitle>Upgrade to Cap Pro</DialogTitle>
              </div>

              <div className="flex flex-col items-center py-6">
                <div className="flex flex-col items-center">
                  <Pro
                    className="w-[250px] h-[120px]"
                    onMouseEnter={handleProHover}
                  />
                  <h1 className="text-3xl font-bold text-gray-12">
                    Upgrade to Cap Pro
                  </h1>
                </div>

                <p className="mt-1 text-lg text-gray-11">
                  You can cancel anytime. Early adopter pricing locked in.
                </p>

                <div className="flex flex-col items-center mt-3 mb-4 w-full">
                  <div className="flex items-end mb-1">
                    <h3 className="text-3xl font-medium text-gray-12">
                      ${totalPrice}/mo
                    </h3>
                    <span className="mb-1 ml-2 text-gray-11">
                      {proQuantity === 1 ? (
                        `per user, ${billingText}`
                      ) : (
                        <>
                          for <strong>{proQuantity}</strong> users,{" "}
                          {billingText}
                        </>
                      )}
                    </span>
                  </div>

                  <div className="flex justify-between items-center mt-8 w-full max-w-md">
                    <div className="flex items-center">
                      <span className="mr-3 text-gray-12">Annual billing</span>
                      <Switch
                        checked={isAnnual}
                        onCheckedChange={() => setIsAnnual(!isAnnual)}
                      />
                    </div>

                    <div className="flex items-center">
                      <span className="mr-3 text-gray-12">Users:</span>
                      <div className="flex items-center">
                        <button
                          onClick={() =>
                            proQuantity > 1 && setProQuantity(proQuantity - 1)
                          }
                          className="flex justify-center items-center w-8 h-8 rounded-l-md bg-gray-4 hover:bg-gray-5"
                          disabled={proQuantity <= 1}
                        >
                          <Minus className="w-4 h-4 text-gray-12" />
                        </button>
                        <div className="flex justify-center items-center w-10 h-8 text-gray-12 bg-gray-3">
                          {proQuantity}
                        </div>
                        <button
                          onClick={() => setProQuantity(proQuantity + 1)}
                          className="flex justify-center items-center w-8 h-8 rounded-r-md bg-gray-4 hover:bg-gray-5"
                        >
                          <Plus className="w-4 h-4 text-gray-12" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                <Button
                  variant="primary"
                  onClick={planCheckout}
                  className="w-full max-w-md h-14 text-lg rounded-xl"
                  disabled={proLoading}
                >
                  {proLoading ? "Loading..." : "Upgrade to Cap Pro"}
                </Button>
              </div>

              <div className="pt-8 mt-4 border-t border-gray-5">
                <h2 className="mb-10 text-2xl font-bold text-center text-gray-12">
                  Here's what's included
                </h2>

                <div className="grid grid-cols-1 gap-x-10 gap-y-12 md:grid-cols-2">
                  {proFeatures.map((feature, index) => (
                    <div key={index} className="flex flex-col items-center">
                      <div className="mb-3">{feature.icon}</div>
                      <h3 className="mb-1 text-lg font-medium text-gray-12">
                        {feature.title}
                      </h3>
                      <p className="text-center text-gray-11">
                        {feature.description}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
};
