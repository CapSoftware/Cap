"use client";

import { Button, Input } from "@cap/ui";
import { useRouter } from "next/navigation";
import { startTransition, useState } from "react";
import { toast } from "sonner";
import { Base } from "../components/Base";

export default function YourNamePage() {
	const [loading, setLoading] = useState(false);
	const [firstName, setFirstName] = useState("");
	const [lastName, setLastName] = useState("");
	const router = useRouter();

	const welcomeRequest = async () => {
		const response = await fetch("/api/settings/onboarding/welcome", {
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
			await welcomeRequest();
			startTransition(() => {
				router.push("/onboarding/organization-setup");
				router.refresh();
			});
		} catch {
			toast.error("An error occurred, please try again");
		} finally {
			setLoading(false);
		}
	};

	return (
		<Base
			title="Welcome to Cap"
			description="Lets get you started"
			hideBackButton
		>
			<form className="space-y-7" onSubmit={handleSubmit}>
				<div className="space-y-3">
					<Input
						value={firstName}
						disabled={loading}
						onChange={(e) => setFirstName(e.target.value)}
						type="text"
						placeholder="First name"
						name="firstName"
						required
					/>
					<Input
						value={lastName}
						disabled={loading}
						onChange={(e) => setLastName(e.target.value)}
						type="text"
						placeholder="Last name (optional)"
						name="lastName"
					/>
				</div>
				<div className="w-full h-px bg-gray-4" />
				<Button
					spinner={loading}
					disabled={!firstName || loading}
					type="submit"
					variant="dark"
					className="mx-auto w-full"
				>
					Continue
				</Button>
			</form>
		</Base>
	);
}
