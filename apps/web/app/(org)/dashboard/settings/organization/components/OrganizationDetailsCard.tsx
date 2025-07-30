"use client";

import { Card, CardDescription, CardHeader, CardTitle } from "@cap/ui";
import { CustomDomain } from "./CustomDomain";
import { OrganizationIcon } from "./OrganizationIcon";
import OrgName from "./OrgName";
import AccessEmailDomain from "./AccessEmailDomain";

export const OrganizationDetailsCard = () => {

  return (
    <Card className="flex flex-col flex-1 gap-6 w-full min-h-fit">
      <CardHeader>
        <CardTitle>Settings</CardTitle>
        <CardDescription>
          Set the organization name, access email domain, custom domain, and organization icon.
        </CardDescription>
      </CardHeader>
      <OrgName />
      <AccessEmailDomain />
      <CustomDomain />
      <OrganizationIcon />
    </Card>
  );
};

