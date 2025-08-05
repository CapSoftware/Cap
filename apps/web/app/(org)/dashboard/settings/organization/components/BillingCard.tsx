"use client";

import { Button, Card, CardDescription, CardHeader, CardTitle } from "@cap/ui";

interface BillingCardProps {
  isOwner: boolean;
  loading: boolean;
  handleManageBilling: () => Promise<void>;
}

export const BillingCard = ({
  isOwner,
  loading,
  handleManageBilling,
}: BillingCardProps) => {
  return (
    <Card className="flex flex-wrap gap-6 justify-between items-center w-full">
      <CardHeader>
        <CardTitle>View and manage your billing details</CardTitle>
        <CardDescription>
          View and edit your billing details, as well as manage your
          subscription.
        </CardDescription>
      </CardHeader>
      <Button
        type="button"
        size="sm"
        variant="dark"
        spinner={loading}
        onClick={handleManageBilling}
        disabled={!isOwner || loading}
      >
        {loading ? "Loading..." : "Manage Billing"}
      </Button>
    </Card>
  );
};
