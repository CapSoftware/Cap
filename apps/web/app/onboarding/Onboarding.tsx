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
import { useState } from "react";
import toast from "react-hot-toast";

export const Onboarding = ({
  user,
}: {
  user: typeof users.$inferSelect | null;
}) => {
  const router = useRouter();
  const [firstNameInput, setFirstNameInput] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    setLoading(true);

    const formData = new FormData(e.currentTarget);
    const firstName = formData.get("firstName") as string;
    const lastName = formData.get("lastName") as string;

    try {
      const response = await fetch("/api/settings/onboarding", {
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

      setLoading(false);
    } catch (error) {
      console.error("Error updating name:", error);
      toast.error("An error occurred while updating name");
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <Card noStyle>
        <CardContent>
          <div className="space-y-3">
            <div>
              <Label htmlFor="firstName">First name *</Label>
              <Input
                type="text"
                id="firstName"
                name="firstName"
                required
                value={firstNameInput}
                onChange={(e) => setFirstNameInput(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="lastName">Last name</Label>
              <Input type="text" id="lastName" name="lastName" />
            </div>
          </div>
        </CardContent>
        <CardFooter className="border-t px-6 py-4">
          <Button
            disabled={!firstNameInput}
            className="mx-auto"
            type="submit"
            size="lg"
            spinner={loading}
          >
            Complete
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
};
