"use client";

import { users } from "@cap/database/schema";
import { Button, Card, CardDescription, CardTitle, Input } from "@cap/ui";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

export const Settings = ({
  user,
}: {
  user?: typeof users.$inferSelect | null;
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
      <div className="flex flex-col flex-wrap gap-6 w-full md:flex-row">
        <Card className="flex-1 space-y-1">
          <CardTitle>Your name</CardTitle>
          <CardDescription>
            Changing your name below will update how your name appears when
            sharing a Cap, and in your profile.
          </CardDescription>
          <div className="flex flex-col flex-wrap gap-5 pt-4 w-full md:flex-row">
            <div className="flex-1 space-y-2">
              <Input
                type="text"
                placeholder="First name"
                defaultValue={firstName as string}
                id="firstName"
                name="firstName"
              />
            </div>
            <div className="flex-1 space-y-2">
              <Input
                type="text"
                placeholder="Last name"
                defaultValue={lastName as string}
                id="lastName"
                name="lastName"
              />
            </div>
          </div>
        </Card>
        <Card className="flex flex-col flex-1 gap-4 justify-between items-stretch">
          <div className="space-y-1">
            <CardTitle>Contact email address</CardTitle>
            <CardDescription>
              This is the email address you used to sign up to Cap with.
            </CardDescription>
          </div>
          <Input
            type="email"
            value={email as string}
            id="contactEmail"
            name="contactEmail"
            disabled
          />
        </Card>
      </div>
      <Button className="mt-6" type="submit" size="sm" variant="dark">
        Save
      </Button>
    </form>
  );
};
