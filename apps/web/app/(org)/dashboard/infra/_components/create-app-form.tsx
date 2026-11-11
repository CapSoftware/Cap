"use client";

import { Button, Input, Label } from "@cap/ui";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { createDeveloperApp } from "@/actions/developers/create-app";
import { infraAppPath } from "@/lib/infra-routes";
import { ApiKeyDisplay } from "./api-key-display";
import { EnvironmentPicker } from "./environment-picker";
import { rememberInfraApp } from "./remember-infra-app";

type CreatedApp = { appId: string; publicKey: string; secretKey: string };

export function CreateAppForm({
	onCancel,
	onDone,
	footerClassName,
}: {
	onCancel?: () => void;
	onDone?: () => void;
	footerClassName?: string;
}) {
	const router = useRouter();
	const nameId = useId();
	const [name, setName] = useState("");
	const [environment, setEnvironment] = useState<"development" | "production">(
		"development",
	);
	const [created, setCreated] = useState<CreatedApp | null>(null);

	const createMutation = useMutation({
		mutationFn: () => createDeveloperApp({ name, environment }),
		onSuccess: (result) => setCreated(result),
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : "Could not create the app",
			);
		},
	});

	const finish = () => {
		if (!created) return;
		rememberInfraApp(created.appId);
		onDone?.();
		router.push(infraAppPath(created.appId));
	};

	if (created) {
		return (
			<div className="flex flex-col gap-5">
				<p className="text-sm text-gray-11">
					Copy your secret key now. It is only shown once.
				</p>
				<ApiKeyDisplay label="Public key" value={created.publicKey} />
				<ApiKeyDisplay label="Secret key" value={created.secretKey} sensitive />
				<div className={footerClassName ?? "flex gap-2 justify-end"}>
					<Button variant="dark" size="sm" onClick={finish}>
						Open app
					</Button>
				</div>
			</div>
		);
	}

	return (
		<form
			className="flex flex-col gap-5"
			onSubmit={(e) => {
				e.preventDefault();
				if (!name.trim() || createMutation.isPending) return;
				createMutation.mutate();
			}}
		>
			<div className="flex flex-col gap-2">
				<Label htmlFor={nameId}>App name</Label>
				<Input
					id={nameId}
					value={name}
					maxLength={255}
					onChange={(e) => setName(e.target.value)}
					placeholder="My app"
				/>
			</div>
			<EnvironmentPicker value={environment} onChange={setEnvironment} />
			<div className={footerClassName ?? "flex gap-2 justify-end"}>
				{onCancel && (
					<Button type="button" variant="gray" size="sm" onClick={onCancel}>
						Cancel
					</Button>
				)}
				<Button
					type="submit"
					variant="dark"
					size="sm"
					disabled={!name.trim() || createMutation.isPending}
					spinner={createMutation.isPending}
				>
					Create app
				</Button>
			</div>
		</form>
	);
}
