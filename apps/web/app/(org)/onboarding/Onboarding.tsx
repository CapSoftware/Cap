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
	const [showUpgradeModal, setShowUpgradeModal] = useState(false);

	const onboardingRequest = async () => {
		const response = await fetch("/api/settings/onboarding", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ firstNameInput, lastNameInput }),
		});
		return response;
	};

	const { mutate: onboardingMutate, isPending } = useMutation({
		mutationFn: async () => await onboardingRequest(),
		onSuccess: async (response) => {
			const data = await response.json();
			router.push("/dashboard");
			if (!data.isMemberOfOrganization) setShowUpgradeModal(true);
		},
		onError: () => {
			toast.error("Failed to complete onboarding");
		},
	});

	const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		onboardingMutate();
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
					disabled={!firstNameInput || !lastNameInput || isPending}
					className="mx-auto mt-6 w-full"
					type="submit"
					spinner={isPending}
				>
					{isPending ? "Submitting..." : "Submit"}
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
