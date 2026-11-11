"use client";

import { Button, Input, Label } from "@cap/ui";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { deleteDeveloperApp } from "@/actions/developers/delete-app";
import { updateDeveloperApp } from "@/actions/developers/update-app";
import { ConfirmationDialog } from "@/app/(org)/dashboard/_components/ConfirmationDialog";
import { INFRA_BASE_PATH } from "@/lib/infra-routes";
import { EnvironmentPicker } from "../../_components/environment-picker";
import { forgetInfraApp } from "../../_components/remember-infra-app";
import { Panel, Section } from "../../_components/section";

type Environment = "development" | "production";

export function AppSettingsClient({
	appId,
	name: initialName,
	environment: initialEnvironment,
	domains,
}: {
	appId: string;
	name: string;
	environment: Environment;
	domains: React.ReactNode;
}) {
	const router = useRouter();
	const nameId = useId();
	const [name, setName] = useState(initialName);
	const [environment, setEnvironment] =
		useState<Environment>(initialEnvironment);
	const [confirmDelete, setConfirmDelete] = useState(false);

	const dirty =
		name.trim() !== initialName || environment !== initialEnvironment;

	const update = useMutation({
		mutationFn: () => updateDeveloperApp({ appId, name, environment }),
		onSuccess: () => {
			toast.success("App saved");
			router.refresh();
		},
		onError: (error) =>
			toast.error(
				error instanceof Error ? error.message : "Could not save the app",
			),
	});

	const remove = useMutation({
		mutationFn: () => deleteDeveloperApp(appId),
		onSuccess: () => {
			forgetInfraApp();
			toast.success("App deleted");
			router.push(INFRA_BASE_PATH);
		},
		onError: () => toast.error("Could not delete the app"),
	});

	return (
		<>
			<Section title="General">
				<Panel className="p-5">
					<form
						className="flex flex-col gap-5"
						onSubmit={(e) => {
							e.preventDefault();
							if (!dirty || !name.trim() || update.isPending) return;
							update.mutate();
						}}
					>
						<div className="flex flex-col gap-2">
							<Label htmlFor={nameId}>App name</Label>
							<Input
								id={nameId}
								value={name}
								maxLength={255}
								onChange={(e) => setName(e.target.value)}
								className="max-w-md"
							/>
						</div>
						<EnvironmentPicker value={environment} onChange={setEnvironment} />
						<Button
							type="submit"
							variant="dark"
							size="sm"
							className="self-start"
							disabled={!dirty || !name.trim() || update.isPending}
							spinner={update.isPending}
						>
							Save
						</Button>
					</form>
				</Panel>
			</Section>

			{domains}

			<Section title="Delete app">
				<Panel className="flex flex-wrap gap-4 justify-between items-center p-5">
					<p className="max-w-lg text-sm text-gray-10">
						Revokes both API keys straight away. Anything using them stops
						working.
					</p>
					<Button
						variant="destructive"
						size="sm"
						onClick={() => setConfirmDelete(true)}
					>
						Delete app
					</Button>
				</Panel>
			</Section>

			<ConfirmationDialog
				open={confirmDelete}
				title="Delete app"
				description={`Delete ${initialName}? Its API keys are revoked immediately. This cannot be undone here.`}
				confirmLabel="Delete app"
				confirmVariant="destructive"
				loading={remove.isPending}
				onConfirm={() => remove.mutate()}
				onCancel={() => {
					if (!remove.isPending) setConfirmDelete(false);
				}}
			/>
		</>
	);
}
