"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Button,
  Input,
  Label,
} from "@cap/ui";
import { users } from "@cap/database/schema";
import { useRouter } from "next/navigation";
import { useState } from "react";

export const Billing = ({
  user,
}: {
  user: typeof users.$inferSelect | null;
}) => {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Billing</CardTitle>
        <CardDescription>Manage all things billing.</CardDescription>
      </CardHeader>
      <CardContent>
        <CardTitle>View and manage your billing details</CardTitle>
        <CardDescription>
          View and edit your billing details, as well as manage your
          subscription.
        </CardDescription>
        <CardDescription className="mt-3">
          <Button
            type="button"
            size="sm"
            variant="default"
            onClick={() => {
              setLoading(true);
              fetch(`/api/settings/billing/manage`, {
                method: "POST",
              })
                .then(async (res) => {
                  const url = await res.json();
                  router.push(url);
                })
                .catch((err) => {
                  alert(err);
                  setLoading(false);
                });
            }}
            spinner={loading}
          >
            Manage Billing
          </Button>
        </CardDescription>
      </CardContent>
    </Card>
  );
};
