"use client";

import { Card } from "@cap/ui";
import { CustomDomain } from "./CustomDomain";
import { OrganizationIcon } from "./OrganizationIcon";
import OrgName from "./OrgName";
import AccessEmailDomain from "./AccessEmailDomain";

export const OrganizationDetailsCard = () => {

  return (
    <Card className="flex flex-col flex-1 gap-6 w-full min-h-fit">
      <OrgName />
      <AccessEmailDomain />
      <CustomDomain />
      <OrganizationIcon />
    </Card>
  );
};

