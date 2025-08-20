"use client";

import { Button, Input } from "@cap/ui";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { UpgradeModal } from "@/components/UpgradeModal";

export const Onboarding = () => {
	const router = useRouter();
	const [firstNameInput, setFirstNameInput] = useState("");
	const [lastNameInput, setLastNameInput] = useState("");
	const [loading, setLoading] = useState(false);
	const [showUpgradeModal, setShowUpgradeModal] = useState(false);

	const onboardingMutate = useMutation({
		mutationFn: async () => {
			setLoading(true);
			const response = await fetch("/api/settings/onboarding", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ firstNameInput, lastNameInput }),
			});
			return response;
		},
		onSuccess: async (response) => {
			setLoading(false);
			router.push("/dashboard");
			const data = await response.json();
			if (!data.isMemberOfOrganization) setShowUpgradeModal(true);
		},
		onError: () => {
			setLoading(false);
			toast.error("Failed to complete onboarding");
		},
	});

	const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		onboardingMutate.mutate();
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
							required
							value={lastNameInput}
							onChange={(e) => setLastNameInput(e.target.value)}
						/>
					</div>
				</div>
				<Button
					disabled={!firstNameInput || loading}
					className="mx-auto mt-6 w-full"
					type="submit"
					spinner={loading}
				>
					{loading ? "Submitting..." : "Submit"}
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
