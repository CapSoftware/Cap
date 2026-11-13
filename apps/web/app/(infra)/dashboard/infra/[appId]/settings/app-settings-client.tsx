"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { deleteDeveloperApp } from "@/actions/developers/delete-app";
import { updateDeveloperApp } from "@/actions/developers/update-app";
import { useEffectMutation } from "@/lib/EffectRuntime";
import { INFRA_BASE_PATH } from "@/lib/infra-routes";
import { formatCredits } from "@/lib/infra-usage";
import {
	type Environment,
	EnvironmentChoice,
} from "../../_components/create-app";
import { ConfirmDialog } from "../../_components/dialog";
import { forgetInfraApp } from "../../_components/remember-infra-app";
import { actionMessage, runAction } from "../../_components/run-action";
import { Button, Input, PageHeader, Split } from "../../_components/ui";

export function AppSettingsClient({
	appId,
	name: initialName,
	environment: initialEnvironment,
	balanceMicroCredits,
	videoCount,
}: {
	appId: string;
	name: string;
	environment: Environment;
	balanceMicroCredits: number;
	videoCount: number;
}) {
	const router = useRouter();
	const nameId = useId();
	const [name, setName] = useState(initialName);
	const [environment, setEnvironment] =
		useState<Environment>(initialEnvironment);
	const [confirmDelete, setConfirmDelete] = useState(false);

	const dirty =
		name.trim() !== initialName || environment !== initialEnvironment;

	const update = useEffectMutation({
		mutationFn: () =>
			runAction(() => updateDeveloperApp({ appId, name, environment })),
		onSuccess: () => {
			toast.success("App saved");
			router.refresh();
		},
		onError: (cause) =>
			toast.error(actionMessage(cause, "Could not save the app")),
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
			<PageHeader title="Settings" />

			<div>
				<Split
					title="General"
					description="The name, and whether it is for testing or live traffic."
				>
					<form
						className="flex flex-col gap-5"
						onSubmit={(e) => {
							e.preventDefault();
							if (!dirty || !name.trim() || update.isPending) return;
							update.mutate();
						}}
					>
						<div>
							<label
								htmlFor={nameId}
								className="mb-2 block text-[13px] text-[rgba(232,236,244,0.58)]"
							>
								App name
							</label>
							<Input
								id={nameId}
								value={name}
								maxLength={255}
								onChange={(e) => setName(e.target.value)}
								className="max-w-[420px]"
							/>
						</div>
						<EnvironmentChoice value={environment} onChange={setEnvironment} />
						<Button
							type="submit"
							className="self-start"
							disabled={!dirty || !name.trim()}
							loading={update.isPending}
						>
							Save
						</Button>
					</form>
				</Split>

				<Split
					title="Delete app"
					description="Revokes its API key straight away and deletes its videos. Any credit left in the app goes with it."
				>
					<Button variant="danger" onClick={() => setConfirmDelete(true)}>
						Delete app
					</Button>
				</Split>
			</div>

			<ConfirmDialog
				open={confirmDelete}
				title="Delete app"
				description={
					<>
						Delete {initialName}? Its API key stops working straight away
						{videoCount > 0 &&
							` and its ${videoCount.toLocaleString("en-US")} ${videoCount === 1 ? "video is" : "videos are"} deleted`}
						.{" "}
						{balanceMicroCredits > 0 ? (
							<>
								The{" "}
								<strong className="font-medium text-[#E8ECF4]">
									{formatCredits(balanceMicroCredits)}
								</strong>{" "}
								of credit left in this app is lost with it. Credit cannot be
								moved to another app.
							</>
						) : (
							"This app has no credit left to lose."
						)}{" "}
						This cannot be undone here.
					</>
				}
				confirmLabel="Delete app"
				loading={remove.isPending}
				onConfirm={() => remove.mutate()}
				onCancel={() => {
					if (!remove.isPending) setConfirmDelete(false);
				}}
			/>
		</>
	);
}
