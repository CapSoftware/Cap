"use client";

import { Button, Input } from "@cap/ui";
import { useState } from "react";
import { toast } from "sonner";
import { UpgradeModal } from "@/components/UpgradeModal";

export const Onboarding = () => {
	const [loading, setLoading] = useState(false);
	const [firstName, setFirstName] = useState("");
	const [lastName, setLastName] = useState("");
	const [showUpgradeModal, setShowUpgradeModal] = useState(false);

	const onboardingRequest = async () => {
		const response = await fetch("/api/settings/onboarding", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ firstName, lastName }),
		});

		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}

		return response.json();
	};

	const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		try {
			setLoading(true);
			const response = await onboardingRequest();

			if (!response.isMemberOfOrganization) {
				setShowUpgradeModal(true);
			} else {
				// Force complete page reload to bypass React cache
				window.location.replace("/dashboard");
			}
		} catch {
			toast.error("Failed to complete onboarding");
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
							value={firstName}
							onChange={(e) => setFirstName(e.target.value)}
						/>
					</div>
					<div className="flex flex-col space-y-1">
						<Input
							type="text"
							id="lastName"
							name="lastName"
							placeholder="Last name"
							required
							value={lastName}
							onChange={(e) => setLastName(e.target.value)}
						/>
					</div>
				</div>
				<Button
					disabled={!firstName || !lastName || loading}
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
						window.location.replace("/dashboard");
					}
				}}
			/>
		</>
	);
};
