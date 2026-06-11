"use client";

import { Button, Dialog, DialogContent, Input, Logo } from "@cap/ui";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { verifyCollectionPassword } from "@/actions/collections/password";
import type { SharePageBranding } from "@/lib/share-branding";

export function CollectionPasswordOverlay({
	collectionId,
	collectionName,
	organizationName,
	branding,
	isOpen,
}: {
	collectionId: string;
	collectionName: string;
	organizationName: string;
	branding: SharePageBranding | null;
	isOpen: boolean;
}) {
	const [password, setPassword] = useState("");
	const passwordInputId = useId();
	const router = useRouter();

	const verifyPassword = useMutation({
		mutationFn: () =>
			verifyCollectionPassword(collectionId, password).then((value) => {
				if (value.success) return value.value;
				throw new Error(value.error);
			}),
		onSuccess: (result) => {
			toast.success(result);
			router.refresh();
		},
		onError: (error) => {
			toast.error(error.message);
		},
	});

	return (
		<Dialog open={isOpen}>
			<DialogContent className="w-[95vw] max-w-sm p-4 sm:max-w-md sm:p-6 md:p-8">
				<div className="flex flex-col items-center space-y-4 sm:space-y-6">
					<div className="flex flex-col items-center space-y-3 text-center sm:space-y-4">
						{branding?.type === "custom" ? (
							// biome-ignore lint/performance/noImgElement: arbitrary org-uploaded icon
							<img
								src={branding.imageUrl}
								alt={branding.name}
								className="h-auto max-h-14 w-auto max-w-[160px] object-contain"
							/>
						) : branding?.type === "cap" ? (
							<Logo className="w-16 h-auto sm:w-20 md:w-24" />
						) : null}
						<div className="space-y-2">
							<h2 className="text-lg font-semibold text-gray-12 sm:text-xl">
								{collectionName}
							</h2>
							<p className="max-w-xs px-2 text-xs text-gray-10 sm:max-w-sm sm:px-0 sm:text-sm">
								This collection from {organizationName} is password protected.
								Enter the password to continue.
							</p>
						</div>
					</div>

					<div className="space-y-3 w-full sm:space-y-4">
						<div className="space-y-2">
							<label
								htmlFor={passwordInputId}
								className="text-sm font-medium text-gray-12"
							>
								Password
							</label>
							<Input
								id={passwordInputId}
								type="password"
								value={password}
								onChange={(event) => setPassword(event.target.value)}
								placeholder="Enter password"
								className="w-full"
								autoFocus
								onKeyDown={(event) => {
									if (
										event.key === "Enter" &&
										password.trim() &&
										!verifyPassword.isPending
									)
										verifyPassword.mutate();
								}}
							/>
						</div>
						<Button
							type="button"
							variant="dark"
							size="lg"
							className="w-full"
							spinner={verifyPassword.isPending}
							disabled={verifyPassword.isPending || !password.trim()}
							onClick={() => verifyPassword.mutate()}
						>
							{verifyPassword.isPending ? "Verifying..." : "Access collection"}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
