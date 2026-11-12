"use client";

import clsx from "clsx";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { createDeveloperApp } from "@/actions/developers/create-app";
import { useEffectMutation } from "@/lib/EffectRuntime";
import { infraAppPath } from "@/lib/infra-routes";
import { CopyTextButton, KeyRow } from "./copy";
import { Modal } from "./dialog";
import { rememberInfraApp } from "./remember-infra-app";
import { actionMessage, runAction } from "./run-action";
import { Button, FOCUS, Input } from "./ui";
import { useMayLeave } from "./uploads";

export type Environment = "development" | "production";
export type CreatedApp = {
	appId: string;
	secretKey: string;
};

const ENVIRONMENTS: { value: Environment; label: string }[] = [
	{ value: "development", label: "Development" },
	{ value: "production", label: "Production" },
];

export function EnvironmentChoice({
	value,
	onChange,
	switchable = false,
}: {
	value: Environment;
	onChange: (value: Environment) => void;
	switchable?: boolean;
}) {
	return (
		<div>
			<fieldset className="m-0 inline-flex min-w-0 rounded-[9px] border-0 p-[3px] shadow-[inset_0_0_0_1px_rgba(222,230,246,0.12)]">
				<legend className="sr-only">Environment</legend>
				{ENVIRONMENTS.map((option) => {
					const active = option.value === value;
					return (
						<button
							key={option.value}
							type="button"
							aria-pressed={active}
							onClick={() => onChange(option.value)}
							className={clsx(
								"h-7 rounded-[6px] px-3 text-[13px] transition-colors duration-200",
								active
									? "bg-[rgba(222,230,246,0.12)] text-white"
									: "text-[rgba(232,236,244,0.5)] hover:text-[#E8ECF4]",
								FOCUS,
							)}
						>
							{option.label}
						</button>
					);
				})}
			</fieldset>
			<p className="m-0 mt-2.5 text-[13px] leading-[1.5] text-[rgba(232,236,244,0.46)]">
				Use a development app for testing and a production app for live traffic.
				Both work the same way.
				{switchable && " You can switch at any time in Settings."}
			</p>
		</div>
	);
}

export function useCreateApp(
	onCreated: (
		app: CreatedApp,
		input: { name: string; environment: Environment },
	) => void,
) {
	return useEffectMutation({
		mutationFn: (input: { name: string; environment: Environment }) =>
			runAction(() => createDeveloperApp(input)),
		onSuccess: (result, input) => {
			rememberInfraApp(result.appId);
			onCreated(result, input);
		},
		onError: (cause) => {
			toast.error(actionMessage(cause, "Could not create the app"));
		},
	});
}

export function KeysReveal({ secretKey }: { secretKey: string }) {
	return (
		<div>
			<div className="border-t border-[rgba(222,230,246,0.07)]">
				<KeyRow label="Secret key" value={secretKey} sensitive />
			</div>
			<div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
				<CopyTextButton
					value={`CAP_SECRET_KEY=${secretKey}\n`}
					label="Copy as .env"
				/>
				<p className="m-0 text-[13px] leading-[1.5] text-[rgba(232,236,244,0.46)]">
					Shown once. It belongs on your server, never in a browser.
				</p>
			</div>
		</div>
	);
}

export function AppNameForm({
	submitLabel,
	pending,
	onSubmit,
	onCancel,
	autoFocus = false,
}: {
	submitLabel: string;
	pending: boolean;
	onSubmit: (input: { name: string; environment: Environment }) => void;
	onCancel?: () => void;
	autoFocus?: boolean;
}) {
	const nameId = useId();
	const [name, setName] = useState("");
	const [environment, setEnvironment] = useState<Environment>("development");
	const ready = name.trim().length > 0 && !pending;

	return (
		<form
			className="flex flex-col gap-4"
			onSubmit={(e) => {
				e.preventDefault();
				if (!ready) return;
				onSubmit({ name, environment });
			}}
		>
			<div>
				<label htmlFor={nameId} className="sr-only">
					App name
				</label>
				<Input
					id={nameId}
					value={name}
					maxLength={255}
					autoFocus={autoFocus}
					autoComplete="off"
					onChange={(e) => setName(e.target.value)}
					placeholder="App name, for example Acme Player"
					className="h-10 max-w-[420px]"
				/>
			</div>
			<EnvironmentChoice
				value={environment}
				onChange={setEnvironment}
				switchable
			/>
			<div className="flex gap-2 pt-1">
				<Button type="submit" disabled={!ready} loading={pending}>
					{submitLabel}
				</Button>
				{onCancel && (
					<Button variant="quiet" onClick={onCancel} disabled={pending}>
						Cancel
					</Button>
				)}
			</div>
		</form>
	);
}

export function NewAppModal({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const router = useRouter();
	const [created, setCreated] = useState<
		(CreatedApp & { name: string }) | null
	>(null);
	const create = useCreateApp((app, input) =>
		setCreated({ ...app, name: input.name.trim() }),
	);
	const mayLeave = useMayLeave();

	const close = (next: boolean) => {
		if (!next && created) {
			if (!mayLeave()) return;
			router.push(infraAppPath(created.appId));
			setCreated(null);
		}
		onOpenChange(next);
	};

	return (
		<Modal
			open={open}
			onOpenChange={close}
			dismissible={!created}
			title={created ? "Copy your secret key" : "New app"}
			description={
				created ? (
					<>
						<span className="[overflow-wrap:anywhere]">{created.name}</span> is
						ready. This is the only time its secret key is shown.
					</>
				) : (
					"Each app has its own key, videos and credits."
				)
			}
		>
			{created ? (
				<div className="flex flex-col gap-6">
					<KeysReveal secretKey={created.secretKey} />
					<div className="flex justify-end">
						<Button onClick={() => close(false)}>Open app</Button>
					</div>
				</div>
			) : (
				open && (
					<AppNameForm
						submitLabel="Create app"
						pending={create.isPending}
						onSubmit={(input) => create.mutate(input)}
						onCancel={() => onOpenChange(false)}
						autoFocus
					/>
				)
			)}
		</Modal>
	);
}
