"use client";

import type { users } from "@cap/database/schema";
import { Button, Input } from "@cap/ui";
import { faImage } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Effect } from "effect";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { startTransition, useRef, useState } from "react";
import { toast } from "sonner";
import { useEffectMutation } from "@/lib/EffectRuntime";
import { withRpc } from "@/lib/Rpcs";
import { Base } from "./Base";

export function OrganizationSetupPage({
	user,
}: {
	user: typeof users.$inferSelect | null;
}) {
	const [organizationName, setOrganizationName] = useState(
		user ? `${user.name}'s organization` : "",
	);
	const [selectedFile, setSelectedFile] = useState<File | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const router = useRouter();

	const handleFileChange = () => {
		const file = fileInputRef.current?.files?.[0];
		if (file) {
			setSelectedFile(file);
		}
	};

	const orgSetupMutation = useEffectMutation({
		mutationFn: (data: { organizationName: string; icon?: File }) =>
			Effect.gen(function* () {
				let organizationIcon:
					| {
							data: Uint8Array;
							contentType: string;
							fileName: string;
					  }
					| undefined;

				if (data.icon) {
					const icon = data.icon;
					const arrayBuffer = yield* Effect.promise(() => icon.arrayBuffer());
					organizationIcon = {
						data: new Uint8Array(arrayBuffer),
						contentType: icon.type,
						fileName: icon.name,
					};
				}

				yield* withRpc((r) =>
					r.UserCompleteOnboardingStep({
						step: "organizationSetup",
						data: {
							organizationName: data.organizationName,
							organizationIcon,
						},
					}),
				);
			}),
		onSuccess: () => {
			startTransition(() => {
				router.push("/onboarding/custom-domain");
				router.refresh();
			});
		},
		onError: (error) => {
			console.error(error);
			toast.error("An error occurred, please try again");
		},
	});

	const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		orgSetupMutation.mutate({
			organizationName,
			icon: selectedFile || undefined,
		});
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
						disabled={orgSetupMutation.isPending}
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
									disabled={orgSetupMutation.isPending}
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
					spinner={orgSetupMutation.isPending}
					disabled={orgSetupMutation.isPending}
				>
					Create Organization
				</Button>
			</form>
		</Base>
	);
}
