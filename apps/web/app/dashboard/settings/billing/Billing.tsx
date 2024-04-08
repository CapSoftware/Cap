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
import toast from "react-hot-toast";

export const Billing = ({
  user,
}: {
  user: typeof users.$inferSelect | null;
}) => {
  const router = useRouter();

  return (
    <form>
      <Card>
        <CardHeader>
          <CardTitle>Billing</CardTitle>
          <CardDescription>Manage all things billing.</CardDescription>
        </CardHeader>
        <CardContent>
          <CardTitle>View and manage your billing details</CardTitle>
          <CardDescription>
            View and edit your billing details, as well as cancel your
            subscription.
          </CardDescription>
          <CardDescription className="mt-3">
            <Button size="sm">Manage billing</Button>
          </CardDescription>
        </CardContent>
      </Card>
    </form>
  );
};
