"use client";

import { users } from "@cap/database/schema";
import { Button, CardContent, Input, Label } from "@cap/ui";
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
        // Redirect to dashboard after successful onboarding
        router.push("/dashboard");
      } else {
        toast.error("Failed to update name");
      }
    } catch (error) {
      console.error("Error updating name:", error);
      toast.error("An error occurred while updating name");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form
      className="relative w-[calc(100%-2%)] p-[28px] max-w-[472px] bg-gray-100 border border-gray-200 rounded-2xl"
      onSubmit={handleSubmit}
    >
      <CardContent>
        <div className="space-y-3">
          <div className="flex flex-col space-y-1">
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
          <div className="flex flex-col space-y-1">
            <Label htmlFor="lastName">Last name</Label>
            <Input type="text" id="lastName" name="lastName" />
          </div>
        </div>
      </CardContent>
      <Button
        disabled={!firstNameInput}
        className="mx-auto"
        type="submit"
        size="sm"
        spinner={loading}
      >
        Complete
      </Button>
    </form>
  );
};
