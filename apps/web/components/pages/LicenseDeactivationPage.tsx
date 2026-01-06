"use client";

import { Button } from "@cap/ui";
import { useId, useState } from "react";
import { toast } from "sonner";

export const LicenseDeactivationPage = () => {
	const licenseKeyId = useId();
	const emailId = useId();
	const [licenseKey, setLicenseKey] = useState("");
	const [email, setEmail] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();

		if (!licenseKey.trim() || !email.trim()) {
			toast.error("Please fill in all fields");
			return;
		}

		setIsSubmitting(true);

		try {
			const response = await fetch(
				"https://l.cap.so/api/commercial/deactivate",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						licensekey: licenseKey.trim(),
					},
					body: JSON.stringify({ email: email.trim() }),
				},
			);

			const data = await response.json();

			if (!response.ok) {
				toast.error(data.message || "Failed to deactivate license");
				return;
			}

			toast.success("License deactivated successfully");
			setLicenseKey("");
			setEmail("");
		} catch (_error) {
			toast.error("An error occurred. Please try again.");
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<div className="py-32 md:py-40 wrapper wrapper-sm">
			<div className="mb-14 text-center page-intro">
				<h1>Deactivate License</h1>
				<p className="mt-4 text-lg text-gray-10">
					Enter your license key and purchase email to deactivate your Cap
					commercial license from its current device.
				</p>
			</div>
			<div className="mx-auto max-w-md">
				<form onSubmit={handleSubmit} className="space-y-6">
					<div>
						<label
							htmlFor={licenseKeyId}
							className="block mb-2 text-sm font-medium text-gray-12"
						>
							License Key
						</label>
						<input
							type="text"
							id={licenseKeyId}
							value={licenseKey}
							onChange={(e) => setLicenseKey(e.target.value)}
							placeholder="XXXX-XXXX-XXXX-XXXX"
							className="flex px-4 w-full font-thin transition-all duration-200 text-[16px] md:text-[13px] text-gray-12 bg-gray-1 border-gray-4 outline-0 focus:bg-gray-2 rounded-xl hover:bg-gray-2 autofill:bg-gray-1 hover:border-gray-5 h-[44px] placeholder:text-gray-8 border-[1px] focus:border-gray-5 ring-0 ring-gray-2 focus:ring-1 focus:ring-gray-12 focus:ring-offset-2 ring-offset-gray-3 hover:placeholder:text-gray-12 placeholder:transition-all placeholder:duration-200"
							disabled={isSubmitting}
						/>
					</div>
					<div>
						<label
							htmlFor={emailId}
							className="block mb-2 text-sm font-medium text-gray-12"
						>
							Purchase Email
						</label>
						<input
							type="email"
							id={emailId}
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							placeholder="you@example.com"
							className="flex px-4 w-full font-thin transition-all duration-200 text-[16px] md:text-[13px] text-gray-12 bg-gray-1 border-gray-4 outline-0 focus:bg-gray-2 rounded-xl hover:bg-gray-2 autofill:bg-gray-1 hover:border-gray-5 h-[44px] placeholder:text-gray-8 border-[1px] focus:border-gray-5 ring-0 ring-gray-2 focus:ring-1 focus:ring-gray-12 focus:ring-offset-2 ring-offset-gray-3 hover:placeholder:text-gray-12 placeholder:transition-all placeholder:duration-200"
							disabled={isSubmitting}
						/>
					</div>
					<Button
						type="submit"
						variant="primary"
						className="w-full"
						disabled={isSubmitting}
						spinner={isSubmitting}
					>
						{isSubmitting ? "Deactivating..." : "Deactivate License"}
					</Button>
				</form>
				<p className="mt-6 text-sm text-center text-gray-10">
					After deactivating, you can activate your license on a different
					device.
				</p>
			</div>
		</div>
	);
};
