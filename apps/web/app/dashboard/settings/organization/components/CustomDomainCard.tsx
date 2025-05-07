"use client";

import { Card, CardDescription, Label } from "@cap/ui";
import { CustomDomain } from "./CustomDomain";

export const CustomDomainCard = () => {
  return (
    <Card className="flex flex-col flex-1 gap-6 w-full lg:flex-row">
      <div className="flex-1">
        <div className="space-y-1">
          <Label htmlFor="customDomain">Custom Domain</Label>
          <CardDescription className="w-full max-w-[400px]">
            Set up a custom domain for your organization's shared caps and
            make it unique.
          </CardDescription>
        </div>
        <div className="mt-4">
          <CustomDomain />
        </div>
      </div>
    </Card>
  );
};
