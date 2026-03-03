"use client";

import {
	Button,
	Card,
	CardDescription,
	CardHeader,
	CardTitle,
	Input,
	Label,
} from "@cap/ui";
import { useMutation } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { deleteDeveloperApp } from "@/actions/developers/delete-app";
import { updateDeveloperApp } from "@/actions/developers/update-app";
import { useDevelopersContext } from "../../../DevelopersContext";

export function AppSettingsClient() {
	const { appId } = useParams<{ appId: string }>();
	const { apps } = useDevelopersContext();
	const app = apps.find((a) => a.id === appId);
	const router = useRouter();
	const nameInputId = useId();

	const [name, setName] = useState(app?.name ?? "");
	const [environment, setEnvironment] = useState(
		app?.environment ?? "development",
	);
	const [confirmDelete, setConfirmDelete] = useState(false);

	const updateMutation = useMutation({
		mutationFn: () =>
			updateDeveloperApp({
				appId,
				name,
				environment: environment as "development" | "production",
			}),
		onSuccess: () => {
			toast.success("App updated");
			router.refresh();
		},
		onError: () => toast.error("Failed to update app"),
	});

	const deleteMutation = useMutation({
		mutationFn: () => deleteDeveloperApp(appId),
		onSuccess: () => {
			toast.success("App deleted");
			router.push("/dashboard/developers/apps");
			router.refresh();
		},
		onError: () => toast.error("Failed to delete app"),
	});

	if (!app) {
		return <p className="text-sm text-gray-10">App not found</p>;
	}

	return (
		<div className="flex flex-col gap-5 max-w-xl">
			<Card>
				<CardHeader>
					<CardTitle>General</CardTitle>
					<CardDescription>
						Update your app name and environment.
					</CardDescription>
				</CardHeader>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						updateMutation.mutate();
					}}
					className="flex flex-col gap-4 mt-4"
				>
					<div className="flex flex-col gap-2">
						<Label htmlFor={nameInputId}>App Name</Label>
						<Input
							id={nameInputId}
							value={name}
							onChange={(e) => setName(e.target.value)}
						/>
					</div>
					<div className="flex flex-col gap-2">
						<Label>Environment</Label>
						<div className="flex gap-2">
							<Button
								type="button"
								variant={environment === "development" ? "dark" : "gray"}
								size="sm"
								onClick={() => setEnvironment("development")}
							>
								Development
							</Button>
							<Button
								type="button"
								variant={environment === "production" ? "dark" : "gray"}
								size="sm"
								onClick={() => setEnvironment("production")}
							>
								Production
							</Button>
						</div>
					</div>
					<Button
						type="submit"
						variant="dark"
						size="sm"
						className="self-start"
						spinner={updateMutation.isPending}
						disabled={updateMutation.isPending}
					>
						Save Changes
					</Button>
				</form>
			</Card>

			<Card className="border-red-400/20">
				<CardHeader>
					<CardTitle className="text-red-400">Danger Zone</CardTitle>
					<CardDescription>
						Deleting an app will revoke all API keys and stop all SDK
						integrations.
					</CardDescription>
				</CardHeader>
				<div className="mt-4">
					{!confirmDelete ? (
						<Button
							variant="gray"
							size="sm"
							onClick={() => setConfirmDelete(true)}
						>
							<Trash2 size={14} className="mr-1" />
							Delete App
						</Button>
					) : (
						<div className="flex gap-2">
							<Button
								variant="gray"
								size="sm"
								onClick={() => setConfirmDelete(false)}
							>
								Cancel
							</Button>
							<Button
								variant="dark"
								size="sm"
								className="!bg-red-400 hover:!bg-red-300"
								spinner={deleteMutation.isPending}
								disabled={deleteMutation.isPending}
								onClick={() => deleteMutation.mutate()}
							>
								Confirm Delete
							</Button>
						</div>
					)}
				</div>
			</Card>
		</div>
	);
}
