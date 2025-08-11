"use client";

import { UpgradeModal } from "@/components/UpgradeModal";
import { Button, Input } from "@cap/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

export const Onboarding = () => {
  const router = useRouter();
  const [firstNameInput, setFirstNameInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);

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
        const data = await response.json();

        if (!data.isMemberOfOrganization) setShowUpgradeModal(true);

        toast.success("Name updated successfully");
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
    <>
      <form
        className="relative w-[calc(100%-2%)] p-[28px] max-w-[472px] bg-gray-2 border border-gray-4 rounded-2xl"
        onSubmit={handleSubmit}
      >
        <div className="space-y-3">
          <div className="flex flex-col space-y-1">
            <Input
              type="text"
              id="firstName"
              placeholder="First name"
              name="firstName"
              required
              value={firstNameInput}
              onChange={(e) => setFirstNameInput(e.target.value)}
            />
          </div>
          <div className="flex flex-col space-y-1">
            <Input
              type="text"
              id="lastName"
              name="lastName"
              placeholder="Last name"
            />
          </div>
        </div>
        <Button
          disabled={!firstNameInput}
          className="mx-auto mt-6 w-full"
          type="submit"
          spinner={loading}
        >
          Complete
        </Button>
      </form>

      <UpgradeModal
        open={showUpgradeModal}
        onOpenChange={(open) => {
          setShowUpgradeModal(open);
          if (!open) {
            router.push("/dashboard");
          }
        }}
      />
    </>
  );
};
