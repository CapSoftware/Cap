"use client";

import { users } from "@cap/database/schema";
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
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";

export const Settings = ({
  user,
}: {
  user: typeof users.$inferSelect | null;
}) => {
  const firstName = user ? user?.name : "";
  const lastName = user ? user?.lastName : "";
  const email = user ? user?.email : "";
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    const formData = new FormData(e.currentTarget);
    const firstName = formData.get("firstName") as string;
    const lastName = formData.get("lastName") as string;

    try {
      const response = await fetch("/api/settings/user/name", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ firstName, lastName }),
      });

      if (response.ok) {
        toast.success("Name updated successfully");
        router.refresh();
      } else {
        toast.error("Failed to update name");
      }
    } catch (error) {
      console.error("Error updating name:", error);
      toast.error("An error occurred while updating name");
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <Card>
        <CardHeader>
          <CardTitle>Your name</CardTitle>
          <CardDescription>
            Changing your name below will update how your name appears when
            sharing a Cap, and in your profile.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div>
              <Label htmlFor="firstName">First name</Label>
              <Input
                type="text"
                defaultValue={firstName as string}
                id="firstName"
                name="firstName"
              />
            </div>
            <div>
              <Label htmlFor="lastName">Last name</Label>
              <Input
                type="text"
                defaultValue={lastName as string}
                id="lastName"
                name="lastName"
              />
            </div>
          </div>
        </CardContent>
        <CardHeader>
          <CardTitle>Contact email address</CardTitle>
          <CardDescription>
            This is the email address you used to sign up to Cap with.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div>
            <Input
              type="email"
              value={email as string}
              id="contactEmail"
              name="contactEmail"
              disabled
            />
          </div>
        </CardContent>
        <CardFooter className="border-t px-6 py-4">
          <Button type="submit" size="default">
            Save
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
};
