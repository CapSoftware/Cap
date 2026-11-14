"use client";

import {
	APP_CATEGORY_LABELS,
	type AppCategory,
	BASE_PERMISSION_DESCRIPTION,
	CAP_EVENT_DESCRIPTIONS,
	type CatalogApp,
	CONNECTION_PERMISSION_DESCRIPTIONS,
	isFirstPartyConnectionUrl,
} from "@cap/app-store";
import { Button } from "@cap/ui";
import clsx from "clsx";
import { ArrowLeft, Check, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";
import {
	installAppAction,
	uninstallAppAction,
	updateInstallationAction,
} from "@/actions/app-store";
import type { InstallationView } from "@/lib/app-store/installations";
import { AppIcon } from "./AppIcon";
import { ContentPreview } from "./ContentPreview";
import { PlatformBadges } from "./PlatformBadges";
import { initialDraft, type SettingsDraft, SettingsForm } from "./SettingsForm";
import type { OrganizationOption } from "./types";

const BUILTIN_SETUP_PATH = "/dashboard/settings/organization/integrations";

type Scope =
	| { scope: "user" }
	| { scope: "organization"; organizationId: string };

const scopeKey = (scope: Scope) =>
	scope.scope === "user" ? "user" : `org:${scope.organizationId}`;

export function AppDetail({
	app,
	installations,
	organizations,
	activeOrganizationId,
}: {
	app: CatalogApp;
	installations: InstallationView[];
	organizations: OrganizationOption[];
	activeOrganizationId: string | null;
}) {
	const connectionHost = app.connection
		? isFirstPartyConnectionUrl(app.connection.url)
			? "Cap"
			: new URL(app.connection.url).hostname
		: null;
	const author = app.firstParty ? "Cap" : app.author.name;

	return (
		<div className="flex flex-col gap-8">
			<Link
				href="/dashboard/apps"
				className="inline-flex w-fit items-center gap-1.5 text-[12px] text-gray-10 transition-colors hover:text-gray-12"
			>
				<ArrowLeft className="size-3.5" aria-hidden />
				All apps
			</Link>

			<header className="flex flex-col gap-4 sm:flex-row sm:items-center">
				<AppIcon src={app.icon.url} name={app.name} size={72} />
				<div className="min-w-0 flex-1">
					<h1 className="text-2xl font-medium text-gray-12">{app.name}</h1>
					<p className="mt-0.5 text-[13px] text-gray-10">{app.description}</p>
					<div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-gray-9">
						<span>
							By{" "}
							{app.firstParty ? (
								author
							) : (
								<a
									href={`https://github.com/${app.author.github}`}
									target="_blank"
									rel="noopener noreferrer"
									className="text-gray-11 underline-offset-2 hover:underline"
								>
									{author}
								</a>
							)}
						</span>
						<span aria-hidden>·</span>
						<PlatformBadges platforms={app.platforms} />
					</div>
				</div>
			</header>

			<div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
				<div className="flex min-w-0 flex-col gap-8">
					<ContentPreview
						backgrounds={app.backgrounds}
						captionStyles={app.captionStyles}
						colorLooks={app.colorLooks}
					/>
					{app.screenshots.length > 0 && (
						<div className="flex snap-x gap-3 overflow-x-auto pb-2">
							{app.screenshots.map((screenshot) => (
								<img
									key={screenshot.sha256}
									src={screenshot.url}
									alt=""
									loading="lazy"
									className="aspect-[8/5] w-[420px] max-w-full shrink-0 snap-start rounded-lg border border-gray-3 object-cover"
								/>
							))}
						</div>
					)}
					<Readme markdown={app.readme} />
				</div>

				<aside className="flex flex-col gap-4">
					<InstallPanel
						app={app}
						installations={installations}
						organizations={organizations}
						activeOrganizationId={activeOrganizationId}
					/>

					{app.connection && (
						<section className="rounded-xl border border-gray-3 p-4">
							<h2 className="text-[13px] font-medium text-gray-12">
								What {app.name} can see
							</h2>
							<ul className="mt-3 flex flex-col gap-2 text-[12px] text-gray-10">
								<PermissionItem>{BASE_PERMISSION_DESCRIPTION}</PermissionItem>
								{app.connection.permissions.map((permission) => (
									<PermissionItem key={permission}>
										{CONNECTION_PERMISSION_DESCRIPTIONS[permission]}
									</PermissionItem>
								))}
							</ul>
							{app.connection.events.length > 0 && (
								<>
									<h3 className="mt-4 text-[12px] font-medium text-gray-12">
										It is told when
									</h3>
									<ul className="mt-2 flex flex-col gap-2 text-[12px] text-gray-10">
										{app.connection.events.map((event) => (
											<PermissionItem key={event}>
												{CAP_EVENT_DESCRIPTIONS[event]}
											</PermissionItem>
										))}
									</ul>
								</>
							)}
							<p className="mt-4 text-[11px] leading-relaxed text-gray-9">
								Data is sent to {connectionHost} only for Caps the install can
								see.
							</p>
						</section>
					)}

					<section className="rounded-xl border border-gray-3 p-4">
						<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[12px]">
							<dt className="text-gray-9">Version</dt>
							<dd className="text-right text-gray-12">{app.version}</dd>
							<dt className="text-gray-9">Category</dt>
							<dd className="text-right text-gray-12">
								{app.categories
									.map(
										(category) => APP_CATEGORY_LABELS[category as AppCategory],
									)
									.join(", ")}
							</dd>
							<dt className="text-gray-9">License</dt>
							<dd className="text-right text-gray-12">{app.license}</dd>
						</dl>
						<div className="mt-4 flex flex-col gap-2 border-t border-gray-3 pt-3">
							{[
								["Website", app.homepage],
								["Support", app.support],
								["Privacy policy", app.privacyPolicy],
								[
									"Source",
									`https://github.com/CapSoftware/Cap/tree/main/app-store/apps/${app.id}`,
								],
							]
								.filter((entry): entry is [string, string] => !!entry[1])
								.map(([label, href]) => (
									<a
										key={label}
										href={href}
										target="_blank"
										rel="noopener noreferrer"
										className="inline-flex items-center justify-between text-[12px] text-gray-11 transition-colors hover:text-gray-12"
									>
										{label}
										<ExternalLink className="size-3" aria-hidden />
									</a>
								))}
						</div>
					</section>
				</aside>
			</div>
		</div>
	);
}

function PermissionItem({ children }: { children: React.ReactNode }) {
	return (
		<li className="flex gap-2">
			<Check className="mt-0.5 size-3.5 shrink-0 text-gray-9" aria-hidden />
			<span>{children}</span>
		</li>
	);
}

function Readme({ markdown }: { markdown: string }) {
	return (
		<article className="flex flex-col gap-3 text-[13px] leading-relaxed text-gray-11 [&_a]:text-gray-12 [&_a]:underline [&_a]:underline-offset-2 [&_code]:rounded [&_code]:bg-gray-3 [&_code]:px-1 [&_code]:text-[12px] [&_h1]:text-[16px] [&_h1]:font-medium [&_h1]:text-gray-12 [&_h2]:mt-2 [&_h2]:text-[14px] [&_h2]:font-medium [&_h2]:text-gray-12 [&_h3]:font-medium [&_h3]:text-gray-12 [&_li]:ml-4 [&_ol]:list-decimal [&_strong]:font-medium [&_strong]:text-gray-12 [&_ul]:list-disc">
			<ReactMarkdown
				skipHtml
				disallowedElements={["img", "iframe", "script", "style"]}
				components={{
					a: ({ href, children }) => (
						<a href={href} target="_blank" rel="noopener noreferrer nofollow">
							{children}
						</a>
					),
				}}
			>
				{markdown}
			</ReactMarkdown>
		</article>
	);
}

function InstallPanel({
	app,
	installations,
	organizations,
	activeOrganizationId,
}: {
	app: CatalogApp;
	installations: InstallationView[];
	organizations: OrganizationOption[];
	activeOrganizationId: string | null;
}) {
	const router = useRouter();
	const [pending, startTransition] = useTransition();
	const fields = app.connection?.settings ?? [];
	const [draft, setDraft] = useState<SettingsDraft>(() => initialDraft(fields));
	const [errors, setErrors] = useState<Record<string, string>>();

	const managed = organizations
		.filter((organization) => organization.canManage)
		.sort((a, b) =>
			a.id === activeOrganizationId
				? -1
				: b.id === activeOrganizationId
					? 1
					: 0,
		);
	const active = organizations.find((org) => org.id === activeOrganizationId);
	const userBlocked =
		!!app.connection && !!active?.adminsOnly && !active.canManage;

	const installedKeys = new Set(
		installations.map((installation) =>
			installation.scope === "user"
				? "user"
				: `org:${installation.organizationId}`,
		),
	);
	const scopes: (Scope & { label: string })[] = [
		...(userBlocked ? [] : [{ scope: "user" as const, label: "Just me" }]),
		...managed.map((organization) => ({
			scope: "organization" as const,
			organizationId: organization.id,
			label: `Everyone in ${organization.name}`,
		})),
	].filter((scope) => !installedKeys.has(scopeKey(scope)));
	const [selected, setSelected] = useState(0);
	const scope = scopes[Math.min(selected, scopes.length - 1)];

	if (app.builtin) {
		const canSetUp = active?.canManage;
		return (
			<section className="rounded-xl border border-gray-3 p-4">
				<p className="text-[12px] leading-relaxed text-gray-10">
					{app.name} is built into Cap.{" "}
					{canSetUp
						? "Set it up from your organization settings."
						: "Ask an owner or admin of your organization to set it up."}
				</p>
				{canSetUp && (
					<Button href={BUILTIN_SETUP_PATH} size="sm" className="mt-3 w-full">
						Set up {app.name}
					</Button>
				)}
			</section>
		);
	}

	const install = () => {
		if (!scope) return;
		setErrors(undefined);
		startTransition(async () => {
			const result = await installAppAction({
				appId: app.id,
				scope: scope.scope,
				organizationId:
					scope.scope === "organization" ? scope.organizationId : null,
				settings: draft,
			});
			if (!result.ok) {
				setErrors(result.fieldErrors);
				toast.error(result.error);
				return;
			}
			toast.success(`${app.name} installed`);
			setDraft(initialDraft(fields));
			setSelected(0);
			router.refresh();
		});
	};

	return (
		<div className="flex flex-col gap-4">
			{installations.map((installation) => (
				<InstalledCard
					key={installation.id}
					app={app}
					installation={installation}
				/>
			))}

			{scopes.length > 0 && scope && (
				<section className="flex flex-col gap-4 rounded-xl border border-gray-3 p-4">
					<div>
						<h2 className="text-[13px] font-medium text-gray-12">
							{installations.length > 0
								? "Install for more people"
								: `Install ${app.name}`}
						</h2>
						<p className="mt-0.5 text-[12px] text-gray-9">
							{app.connection
								? "Works on the web and in Cap Desktop as soon as it is installed."
								: "Appears in Cap Desktop the next time it opens."}
						</p>
					</div>

					{scopes.length > 1 && (
						<fieldset className="flex flex-col gap-1.5">
							<legend className="sr-only">Install for</legend>
							{scopes.map((option, index) => (
								<label
									key={scopeKey(option)}
									className={clsx(
										"flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-[12px] transition-colors",
										index === selected
											? "border-gray-12 text-gray-12"
											: "border-gray-4 text-gray-10 hover:border-gray-5",
									)}
								>
									<input
										type="radio"
										name={`install-scope-${app.id}`}
										checked={index === selected}
										onChange={() => setSelected(index)}
										className="size-3 accent-gray-12"
									/>
									{option.label}
								</label>
							))}
						</fieldset>
					)}

					{fields.length > 0 && (
						<SettingsForm
							idPrefix={`install-${app.id}`}
							fields={fields}
							draft={draft}
							onChange={setDraft}
							errors={errors}
							disabled={pending}
						/>
					)}

					<Button
						size="sm"
						onClick={install}
						spinner={pending}
						disabled={pending}
					>
						{scopes.length === 1 && scope.scope === "organization"
							? `Install for ${scope.label.replace("Everyone in ", "")}`
							: "Install"}
					</Button>
				</section>
			)}

			{scopes.length === 0 && installations.length === 0 && userBlocked && (
				<section className="rounded-xl border border-gray-3 p-4 text-[12px] leading-relaxed text-gray-10">
					{active?.name} only lets owners and admins install apps that connect
					to other services. Ask one of them to install {app.name}.
				</section>
			)}
		</div>
	);
}

function InstalledCard({
	app,
	installation,
}: {
	app: CatalogApp;
	installation: InstallationView;
}) {
	const router = useRouter();
	const [pending, startTransition] = useTransition();
	const fields = app.connection?.settings ?? [];
	const [draft, setDraft] = useState<SettingsDraft>(() =>
		initialDraft(fields, installation.settings.values),
	);
	const [errors, setErrors] = useState<Record<string, string>>();
	const who =
		installation.scope === "user"
			? "Installed for you"
			: `Installed for ${installation.organizationName ?? "your organization"}`;

	const update = (
		input: Parameters<typeof updateInstallationAction>[1],
		success: string,
	) => {
		setErrors(undefined);
		startTransition(async () => {
			const result = await updateInstallationAction(installation.id, input);
			if (!result.ok) {
				setErrors(result.fieldErrors);
				toast.error(result.error);
				return;
			}
			toast.success(success);
			setDraft(initialDraft(fields, result.value.settings.values));
			router.refresh();
		});
	};

	const uninstall = () => {
		const target =
			installation.scope === "user"
				? `Uninstall ${app.name}?`
				: `Uninstall ${app.name} for everyone in ${installation.organizationName}?`;
		if (!window.confirm(target)) return;
		startTransition(async () => {
			const result = await uninstallAppAction(installation.id);
			if (!result.ok) {
				toast.error(result.error);
				return;
			}
			toast.success(`${app.name} uninstalled`);
			router.refresh();
		});
	};

	const newPermissions = [
		...(app.connection?.permissions ?? [])
			.filter(
				(permission) => !installation.grantedPermissions.includes(permission),
			)
			.map((permission) => CONNECTION_PERMISSION_DESCRIPTIONS[permission]),
		...(app.connection?.events ?? [])
			.filter((event) => !installation.grantedEvents.includes(event))
			.map((event) => CAP_EVENT_DESCRIPTIONS[event]),
	];

	return (
		<section className="flex flex-col gap-4 rounded-xl border border-gray-3 p-4">
			<div className="flex items-center justify-between gap-3">
				<span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-gray-12">
					<Check className="size-3.5 text-green-600" aria-hidden />
					{who}
				</span>
				{installation.status === "disabled" && (
					<span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-600">
						Paused
					</span>
				)}
			</div>

			{installation.status === "disabled" && (
				<div className="rounded-lg bg-gray-2 p-3 text-[12px] leading-relaxed text-gray-10">
					Cap paused this connection because {app.name} stopped responding for
					several days.
					{installation.canManage && (
						<Button
							size="xs"
							variant="gray"
							className="mt-2"
							disabled={pending}
							onClick={() => update({ resume: true }, `${app.name} resumed`)}
						>
							Resume
						</Button>
					)}
				</div>
			)}

			{installation.needsReview && (
				<div className="rounded-lg bg-gray-2 p-3 text-[12px] leading-relaxed text-gray-10">
					<p className="font-medium text-gray-12">
						{app.name} asks for more access
					</p>
					<ul className="mt-1.5 flex flex-col gap-1">
						{newPermissions.map((item) => (
							<li key={item}>{item}</li>
						))}
					</ul>
					<p className="mt-1.5">
						Until you accept, Cap keeps sending only what you approved before.
					</p>
					{installation.canManage && (
						<Button
							size="xs"
							variant="gray"
							className="mt-2"
							disabled={pending}
							onClick={() =>
								update({ acceptUpdate: true }, "New access approved")
							}
						>
							Accept
						</Button>
					)}
				</div>
			)}

			{fields.length > 0 && installation.canManage && (
				<>
					<SettingsForm
						idPrefix={`settings-${installation.id}`}
						fields={fields}
						draft={draft}
						onChange={setDraft}
						errors={errors}
						secretsSet={installation.settings.secretsSet}
						disabled={pending}
					/>
					<Button
						size="sm"
						variant="gray"
						disabled={pending}
						onClick={() => update({ settings: draft }, "Settings saved")}
					>
						Save settings
					</Button>
				</>
			)}

			{installation.canManage ? (
				<button
					type="button"
					onClick={uninstall}
					disabled={pending}
					className="w-fit text-[12px] text-gray-9 underline-offset-2 transition-colors hover:text-red-500 hover:underline disabled:opacity-50"
				>
					Uninstall
				</button>
			) : (
				<p className="text-[11px] text-gray-9">
					Owners and admins manage apps installed for the organization.
				</p>
			)}
		</section>
	);
}
