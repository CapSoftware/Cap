"use client";

import { manageBilling } from "@/actions/organization/manage-billing";
import { updateOrganizationDetails } from "@/actions/organization/update-details";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { Card, CardDescription, CardTitle } from "@cap/ui";
import { useRouter } from "next/navigation";
import { Dispatch, SetStateAction, useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import { BillingCard } from "./components/BillingCard";
import { CustomDomainIconCard } from "./components/CustomDomainIconCard";
import { InviteDialog } from "./components/InviteDialog";
import { MembersCard } from "./components/MembersCard";
import { OrganizationDetailsCard } from "./components/OrganizationDetailsCard";
import { SeatsInfoCards } from "./components/SeatsInfoCards";

export const
  Organization = () => {
    const { activeOrganization, user } = useDashboardContext();
    const organizationName = activeOrganization?.organization.name;
    const router = useRouter();
    const [loading, setLoading] = useState(false);
    const [billingLoading, setBillingLoading] = useState(false);
    const isOwner = user?.id === activeOrganization?.organization.ownerId;
    const [isInviteDialogOpen, setIsInviteDialogOpen] = useState(false);
    const ownerToastShown = useRef(false);
    const [saveLoading, setSaveLoading] = useState(false);

    const showOwnerToast = useCallback(() => {
      if (!ownerToastShown.current) {
        toast.error("Only the owner can make changes");
        ownerToastShown.current = true;
        setTimeout(() => {
          ownerToastShown.current = false;
        }, 3000);
      }
    }, []);

    const handleSubmit = useCallback(
      async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();

        if (!isOwner) {
          showOwnerToast();
          return;
        }

        const formData = new FormData(e.currentTarget);
        const organizationName = formData.get("organizationName") as string;
        const allowedEmailDomain = formData.get("allowedEmailDomain") as string;

        try {
          setSaveLoading(true);
          await updateOrganizationDetails(
            organizationName,
            allowedEmailDomain,
            activeOrganization?.organization.id as string
          );
          toast.success("Settings updated successfully");
          router.refresh();
        } catch (error) {
          console.error("Error updating settings:", error);
          toast.error("An error occurred while updating settings");
        } finally {
          setSaveLoading(false);
        }
      },
      [isOwner, showOwnerToast, activeOrganization?.organization.id, router]
    );

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

    return (
      <form className="flex flex-col gap-6" onSubmit={handleSubmit}>
        {isOwner === false && (
          <Card>
            <CardTitle>*Only the owner can make changes</CardTitle>
            <CardDescription>
              Only the owner can make changes to this organization.
            </CardDescription>
          </Card>
        )}

        <SeatsInfoCards />

        <div className="flex flex-col gap-6 justify-center items-stretch xl:flex-row">
          <OrganizationDetailsCard
            isOwner={isOwner}
            saveLoading={saveLoading}
            showOwnerToast={showOwnerToast}
            organizationName={organizationName}
          />
          <CustomDomainIconCard
            isOwner={isOwner}
            showOwnerToast={showOwnerToast}
          />
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
