"use client";

import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
	Label,
} from "@cap/ui";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { createDeveloperApp } from "@/actions/developers/create-app";
import { ApiKeyDisplay } from "./ApiKeyDisplay";

export function CreateAppDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const router = useRouter();
	const appNameId = useId();
	const [step, setStep] = useState<"create" | "keys">("create");
	const [name, setName] = useState("");
	const [environment, setEnvironment] = useState<"development" | "production">(
		"development",
	);
	const [keys, setKeys] = useState<{
		publicKey: string;
		secretKey: string;
	} | null>(null);

	const createMutation = useMutation({
		mutationFn: () => createDeveloperApp({ name, environment }),
		onSuccess: (result) => {
			setKeys({
				publicKey: result.publicKey,
				secretKey: result.secretKey,
			});
			setStep("keys");
			router.refresh();
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : "Failed to create app",
			);
		},
	});

	const handleClose = () => {
		setStep("create");
		setName("");
		setEnvironment("development");
		setKeys(null);
		onOpenChange(false);
	};

	return (
		<Dialog open={open} onOpenChange={handleClose}>
			<DialogContent className="max-w-md">
				{step === "create" && (
					<>
						<DialogHeader>
							<DialogTitle>Create Developer App</DialogTitle>
						</DialogHeader>
						<div className="flex flex-col gap-4 p-5">
							<div className="flex flex-col gap-2">
								<Label htmlFor={appNameId}>App Name</Label>
								<Input
									id={appNameId}
									value={name}
									onChange={(e) => setName(e.target.value)}
									placeholder="My App"
								/>
							</div>
							<div className="flex flex-col gap-2">
								<Label>Environment</Label>
								<div className="flex gap-2">
									<Button
										variant={environment === "development" ? "dark" : "gray"}
										size="sm"
										onClick={() => setEnvironment("development")}
									>
										Development
									</Button>
									<Button
										variant={environment === "production" ? "dark" : "gray"}
										size="sm"
										onClick={() => setEnvironment("production")}
									>
										Production
									</Button>
								</div>
							</div>
						</div>
						<DialogFooter>
							<Button variant="gray" size="sm" onClick={handleClose}>
								Cancel
							</Button>
							<Button
								variant="dark"
								size="sm"
								disabled={!name.trim() || createMutation.isPending}
								spinner={createMutation.isPending}
								onClick={() => createMutation.mutate()}
							>
								Create
							</Button>
						</DialogFooter>
					</>
				)}
				{step === "keys" && keys && (
					<>
						<DialogHeader>
							<DialogTitle>API Keys Created</DialogTitle>
						</DialogHeader>
						<div className="flex flex-col gap-4 p-5">
							<p className="text-sm text-gray-10">
								Save your secret key now. You won't be able to see it again.
							</p>
							<ApiKeyDisplay label="Public Key" value={keys.publicKey} />
							<ApiKeyDisplay
								label="Secret Key"
								value={keys.secretKey}
								sensitive
							/>
						</div>
						<DialogFooter>
							<Button variant="dark" size="sm" onClick={handleClose}>
								Done
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
