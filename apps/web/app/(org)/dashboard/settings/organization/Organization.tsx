"use client";

import { manageBilling } from "@/actions/organization/manage-billing";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { Card, CardDescription, CardHeader, CardTitle, Switch } from "@cap/ui";
import { useRouter } from "next/navigation";
import { Dispatch, SetStateAction, useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import { BillingCard } from "./components/BillingCard";
import { InviteDialog } from "./components/InviteDialog";
import { MembersCard } from "./components/MembersCard";
import { OrganizationDetailsCard } from "./components/OrganizationDetailsCard";
import { SeatsInfoCards } from "./components/SeatsInfoCards";
import { AnimatePresence, motion } from "framer-motion";
import clsx from "clsx";

export const
  Organization = () => {
    const { activeOrganization, user } = useDashboardContext();
    const router = useRouter();
    const [loading, setLoading] = useState(false);
    const [billingLoading, setBillingLoading] = useState(false);
    const isOwner = user?.id === activeOrganization?.organization.ownerId;
    const [isInviteDialogOpen, setIsInviteDialogOpen] = useState(false);
    const ownerToastShown = useRef(false);
    const [activeTab, setActiveTab] = useState("Notifications");

    const showOwnerToast = useCallback(() => {
      if (!ownerToastShown.current) {
        toast.error("Only the owner can make changes");
        ownerToastShown.current = true;
        setTimeout(() => {
          ownerToastShown.current = false;
        }, 3000);
      }
    }, []);

    const handleManageBilling = useCallback(
      async (loadingDispatch: Dispatch<SetStateAction<boolean>>) => {
        if (!isOwner) {
          showOwnerToast();
          return;
        }
        loadingDispatch(true);
        try {
          const url = await manageBilling();
          router.push(url);
        } catch (error) {
          console.error("Error managing billing:", error);
          toast.error("An error occurred while managing billing");
          loadingDispatch(false);
        }
      },
      [isOwner, showOwnerToast, router]
    );

    const VideoTabSettings = [
      {
        label: "5 minutes video duration",
        description: "Set the default video duration",
      },
      {
        label: "1080p resolution",
        description: "Set the default video resolution",
      },
      {
        label: "10Mbps bitrate",
        description: "Set the default video bitrate",
      },
    ]

    const NotificationTabSettings = [
      {
        label: "Notifications",
        description: "Set the default notification settings",
      },
      {
        label: "Random",
        description: "Set the default random settings",
      },
      {
        label: "Random",
        description: "Set the default random settings",
      },
    ]

    return (
      <form className="flex flex-col gap-6">

        <SeatsInfoCards />

        <div className="flex flex-col gap-6 justify-center items-stretch xl:flex-row">
          <OrganizationDetailsCard />
          <Card className="flex-1">
            <CardHeader>
              <CardTitle>Cap Settings</CardTitle>
              <CardDescription>
                Enable or disable specific settings for your organization. Notifications, videos, etc...
              </CardDescription>
            </CardHeader>
            <div className="flex gap-4 pb-4 mt-3 border-b border-gray-3">
              {["Notifications", "Videos"].map((setting) => (
                <>
                  <motion.div style={{
                    borderRadius: 12
                  }} onClick={() => setActiveTab(setting)} className={clsx("relative cursor-pointer")} key={setting}>
                    <p className={clsx("relative z-10 text-[13px] px-2.5 py-1.5 font-medium transition-colors duration-200 text-gray-10 hover:text-gray-11", activeTab === setting && "text-gray-12 hover:text-gray-12")}>{setting}</p>
                    {/** Indicator */}
                    {activeTab === setting && (
                      <motion.div
                        layoutId="activeTabIndicator"
                        transition={{ damping: 25, stiffness: 250, type: "spring" }}
                        className="absolute top-0 left-0 w-full h-full rounded-xl bg-gray-3"
                      />
                    )}
                  </motion.div>
                </>
              ))}
            </div>
            <div className="mt-4 space-y-3">

              <AnimatePresence initial={false} mode="wait">
                {activeTab === "Videos" ? (
                  VideoTabSettings.map((setting, index) => (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0, transition: { delay: index * 0.05 } }}
                      exit={{ opacity: 0, y: -10, transition: { duration: 0.2 } }}
                      key={index + setting.label} className="flex justify-between items-center p-3 rounded-xl border border-gray-4">
                      <p className="text-[13px] text-gray-12">{setting.label}</p>
                      <Switch />
                    </motion.div>
                  ))
                ) : (
                  NotificationTabSettings.map((setting, index) => (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0, transition: { delay: index * 0.05 } }}
                      exit={{ opacity: 0, y: -10, transition: { duration: 0.2 } }}
                      key={index + setting.label} className="flex justify-between items-center p-3 rounded-xl border border-gray-4">
                      <p className="text-[13px] text-gray-12">{setting.label}</p>
                      <Switch />
                    </motion.div>
                  ))
                )}
              </AnimatePresence>
            </div>
          </Card>
        </div>


        <MembersCard
          isOwner={isOwner}
          loading={loading}
          handleManageBilling={() => handleManageBilling(setLoading)}
          showOwnerToast={showOwnerToast}
          setIsInviteDialogOpen={setIsInviteDialogOpen}
        />

        <BillingCard
          isOwner={isOwner}
          loading={billingLoading}
          handleManageBilling={() => handleManageBilling(setBillingLoading)}
        />

        <InviteDialog
          isOpen={isInviteDialogOpen}
          setIsOpen={setIsInviteDialogOpen}
          isOwner={isOwner}
          showOwnerToast={showOwnerToast}
          handleManageBilling={() => handleManageBilling(setLoading)}
        />
      </form>
    );
  };
