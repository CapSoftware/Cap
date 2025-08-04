"use client";

import { Card, CardDescription, Label } from "@cap/ui";
import { CustomDomain } from "./CustomDomain";
import { OrganizationIcon } from "./OrganizationIcon";

interface CustomDomainCardProps {
  isOwner: boolean;
  showOwnerToast: () => void;
}

export const CustomDomainIconCard = ({
  isOwner,
  showOwnerToast,
}: CustomDomainCardProps) => {
  return (
    <Card className="flex flex-col flex-1 gap-6 w-full lg:flex-row">
      <div className="order-first lg:order-last">
        <OrganizationIcon isOwner={isOwner} showOwnerToast={showOwnerToast} />
      </div>
      <div className="order-last lg:order-first">
        <div className="space-y-1">
          <Label htmlFor="customDomain">Custom Domain</Label>
          <CardDescription className="w-full max-w-[400px]">
            Set up a custom domain for your organization's shared caps and make
            it unique.
          </CardDescription>
        </div>
        <CustomDomain isOwner={isOwner} showOwnerToast={showOwnerToast} />
      </div>
    </Card>
  );
};
