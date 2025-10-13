"use client";

import { Button, Input } from "@cap/ui";
import { faImage } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Base } from "../components/Base";

export default function OrganizationSetupPage() {
	const [organizationName, setOrganizationName] = useState("");
	const [selectedFile, setSelectedFile] = useState<File | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [isLoading, setIsLoading] = useState(false);
	const router = useRouter();

	const handleFileChange = () => {
		const file = fileInputRef.current?.files?.[0];
		if (file) {
			setSelectedFile(file);
		}
	};

	const orgSetupRequest = async () => {
		const formData = new FormData();
		formData.append("organizationName", organizationName);
		if (selectedFile) {
			formData.append("icon", selectedFile);
		}

		const response = await fetch("/api/settings/onboarding/org-setup", {
			method: "POST",
			body: formData,
		});

		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}

		return response.json();
	};

	const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		try {
			setIsLoading(true);
			await orgSetupRequest();
			router.refresh();
			setTimeout(() => {
				router.push("/onboarding/custom-domain");
			}, 200);
		} catch {
			toast.error("An error occurred, please try again");
		} finally {
			setTimeout(() => {
				setIsLoading(false);
			}, 200);
		}
	};

	return (
		<Base
			title="Organization Setup"
			description="Lets get your dashboard setup with your organization"
		>
			<form onSubmit={handleSubmit} className="space-y-7">
				<div className="space-y-3">
					<Input
						type="text"
						disabled={isLoading}
						value={organizationName}
						onChange={(e) => setOrganizationName(e.target.value)}
						placeholder="Organization Name"
						name="organizationName"
						required
					/>
					<div className="rounded-xl border bg-gray-1 h-fit border-gray-4">
						<h3 className="px-3 py-3 text-sm font-medium border-b border-gray-4 text-gray-12">
							Organization Logo
						</h3>
						<div className="flex gap-5 p-5">
							<div className="flex justify-center items-center rounded-full border border-dashed size-14 bg-gray-3 border-gray-6">
								{selectedFile ? (
									<Image
										src={URL.createObjectURL(selectedFile)}
										alt="Selected File"
										width={56}
										className="object-cover rounded-full size-14"
										height={56}
									/>
								) : (
									<FontAwesomeIcon
										icon={faImage}
										className="size-4 text-gray-9"
									/>
								)}
							</div>
							<input
								type="file"
								className="hidden h-0"
								accept="image/jpeg, image/jpg, image/png, image/svg+xml"
								ref={fileInputRef}
								onChange={handleFileChange}
							/>
							<div className="space-y-3">
								<Button
									type="button"
									variant="gray"
									disabled={isLoading}
									size="xs"
									onClick={() => fileInputRef.current?.click()}
								>
									Upload Image
								</Button>
								<p className="text-xs text-gray-10">
									Recommended size: 120x120
								</p>
							</div>
						</div>
					</div>
				</div>
				<div className="w-full h-px bg-gray-4" />
				<Button
					type="submit"
					variant="dark"
					className="mx-auto w-full"
					spinner={isLoading}
					disabled={isLoading}
				>
					Create Organization
				</Button>
			</form>
		</Base>
	);
}
