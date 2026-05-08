import { Button } from "@cap/ui-solid";
import { DropdownMenu as KDropdownMenu } from "@kobalte/core/dropdown-menu";
import { cx } from "cva";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	on,
	onCleanup,
	Show,
	Suspense,
} from "solid-js";
import toast from "solid-toast";
import { SignInButton } from "~/components/SignInButton";
import {
	createSelectedOrganization,
	type DesktopOrganization,
	EMPTY_ORGANIZATION_BRAND_COLORS,
	encodeFileAsBase64,
	ORGANIZATION_BRAND_COLOR_DEFAULTS,
	ORGANIZATION_BRAND_COLOR_KEYS,
	ORGANIZATION_BRAND_COLOR_LABELS,
	ORGANIZATION_LOGO_CONTENT_TYPES,
	ORGANIZATION_LOGO_MAX_BYTES,
	type OrganizationBrandColorKey,
	type OrganizationBrandColors,
	updateOrganizationBranding,
} from "~/utils/organization-branding";
import IconLucideBuilding2 from "~icons/lucide/building-2";
import IconLucideCheck from "~icons/lucide/check";
import IconLucideImage from "~icons/lucide/image";
import IconLucidePalette from "~icons/lucide/palette";
import IconLucideRefreshCw from "~icons/lucide/refresh-cw";
import IconLucideTrash2 from "~icons/lucide/trash-2";
import IconLucideUpload from "~icons/lucide/upload";
import { hexToRgb, RgbInput, rgbToHex } from "./color-utils";
import {
	Dialog,
	DialogContent,
	DropdownItem,
	EditorButton,
	MenuItemList,
	PopperContent,
	topCenterAnimateClasses,
} from "./ui";

type OrganizationLogoContentType =
	(typeof ORGANIZATION_LOGO_CONTENT_TYPES)[number];

function isSupportedLogoContentType(
	contentType: string,
): contentType is OrganizationLogoContentType {
	return ORGANIZATION_LOGO_CONTENT_TYPES.some((type) => type === contentType);
}

function getOrganizationInitial(organization: DesktopOrganization) {
	return organization.name.trim().slice(0, 1).toUpperCase() || "?";
}

function OrganizationAvatar(props: {
	organization: DesktopOrganization;
	class?: string;
}) {
	return (
		<span
			class={cx(
				"flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-gray-3 text-[11px] font-medium text-gray-12",
				props.class ?? "size-6",
			)}
		>
			<Show
				when={props.organization.iconUrl}
				fallback={getOrganizationInitial(props.organization)}
			>
				{(url) => (
					<img
						src={url()}
						alt=""
						class="size-full object-contain"
						draggable={false}
					/>
				)}
			</Show>
		</span>
	);
}

function colorToRgb(color: string): [number, number, number] {
	const rgb = hexToRgb(color);
	if (!rgb) return [0, 0, 0];
	return [rgb[0], rgb[1], rgb[2]];
}

function BrandSettingsDialog(props: {
	open: boolean;
	organization: DesktopOrganization | null;
	onOpenChange: (open: boolean) => void;
	onSaved: (organization: DesktopOrganization) => void;
}) {
	const [brandColors, setBrandColors] = createSignal<OrganizationBrandColors>(
		EMPTY_ORGANIZATION_BRAND_COLORS,
	);
	const [logoFile, setLogoFile] = createSignal<File | null>(null);
	const [logoRemoved, setLogoRemoved] = createSignal(false);
	const [localLogoPreview, setLocalLogoPreview] = createSignal<string | null>(
		null,
	);
	const [saving, setSaving] = createSignal(false);

	let fileInput!: HTMLInputElement;

	const clearLocalLogoPreview = () => {
		const url = localLogoPreview();
		if (url) URL.revokeObjectURL(url);
		setLocalLogoPreview(null);
	};

	createEffect(
		on(
			() => [props.open, props.organization?.id] as const,
			() => {
				clearLocalLogoPreview();
				setLogoFile(null);
				setLogoRemoved(false);
				setBrandColors({
					...(props.organization?.brandColors ??
						EMPTY_ORGANIZATION_BRAND_COLORS),
				});
				if (fileInput) fileInput.value = "";
			},
		),
	);

	onCleanup(clearLocalLogoPreview);

	const displayedLogoUrl = createMemo(() => {
		if (logoRemoved()) return null;
		return localLogoPreview() ?? props.organization?.iconUrl ?? null;
	});

	const setBrandColor = (
		key: OrganizationBrandColorKey,
		color: string | null,
	) => {
		setBrandColors((current) => ({
			...current,
			[key]: color,
		}));
	};

	const selectLogoFile = (file: File) => {
		if (!isSupportedLogoContentType(file.type)) {
			toast.error("Unsupported logo file type");
			return;
		}
		if (file.size > ORGANIZATION_LOGO_MAX_BYTES) {
			toast.error("Logo file must be less than 1MB");
			return;
		}

		clearLocalLogoPreview();
		setLogoFile(file);
		setLogoRemoved(false);
		setLocalLogoPreview(URL.createObjectURL(file));
	};

	const removeLogo = () => {
		clearLocalLogoPreview();
		setLogoFile(null);
		setLogoRemoved(true);
		if (fileInput) fileInput.value = "";
	};

	const save = async () => {
		const organization = props.organization;
		if (!organization) return;

		setSaving(true);
		try {
			const file = logoFile();
			const logo = file
				? {
						action: "upload" as const,
						contentType: file.type as OrganizationLogoContentType,
						data: await encodeFileAsBase64(file),
					}
				: logoRemoved()
					? { action: "remove" as const }
					: { action: "keep" as const };

			const updatedOrganization = await updateOrganizationBranding(
				organization.id,
				{
					brandColors: brandColors(),
					logo,
				},
			);

			toast.success("Organization branding updated");
			props.onSaved(updatedOrganization);
			props.onOpenChange(false);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to update organization branding",
			);
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog.Root open={props.open} onOpenChange={props.onOpenChange} size="sm">
			<DialogContent
				title={props.organization?.name ?? "Organization"}
				class="gap-5 text-gray-12"
				confirm={
					<>
						<Button
							variant="gray"
							disabled={saving()}
							onClick={() => props.onOpenChange(false)}
						>
							Cancel
						</Button>
						<Dialog.ConfirmButton
							disabled={saving() || !props.organization}
							onClick={() => void save()}
						>
							{saving() ? "Saving..." : "Save"}
						</Dialog.ConfirmButton>
					</>
				}
			>
				<div class="flex items-center gap-3">
					<div class="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-gray-3 text-xl font-medium">
						<Show
							when={displayedLogoUrl()}
							fallback={<IconLucideImage class="size-6 text-gray-10" />}
						>
							{(url) => (
								<img
									src={url()}
									alt=""
									class="size-full object-contain"
									draggable={false}
								/>
							)}
						</Show>
					</div>
					<div class="flex flex-1 gap-2">
						<Button
							variant="gray"
							class="gap-1.5"
							onClick={() => fileInput.click()}
						>
							<IconLucideUpload class="size-4" />
							Upload
						</Button>
						<Show when={displayedLogoUrl() || logoFile()}>
							<Button variant="gray" class="gap-1.5" onClick={removeLogo}>
								<IconLucideTrash2 class="size-4" />
								Remove
							</Button>
						</Show>
					</div>
					<input
						ref={fileInput}
						type="file"
						class="hidden"
						accept={ORGANIZATION_LOGO_CONTENT_TYPES.join(",")}
						onChange={(event) => {
							const file = event.currentTarget.files?.[0];
							if (!file) return;
							selectLogoFile(file);
						}}
					/>
				</div>

				<div class="flex flex-col gap-3">
					<For each={ORGANIZATION_BRAND_COLOR_KEYS}>
						{(key) => {
							const color = createMemo(() => brandColors()[key]);

							return (
								<div class="flex min-h-10 items-center gap-3">
									<span class="w-24 text-sm font-medium text-gray-11">
										{ORGANIZATION_BRAND_COLOR_LABELS[key]}
									</span>
									<div class="flex flex-1 items-center justify-end gap-2">
										<Show
											when={color()}
											fallback={
												<Button
													variant="gray"
													onClick={() =>
														setBrandColor(
															key,
															ORGANIZATION_BRAND_COLOR_DEFAULTS[key],
														)
													}
												>
													Set
												</Button>
											}
										>
											{(value) => (
												<>
													<RgbInput
														value={colorToRgb(value())}
														onChange={(rgb) =>
															setBrandColor(key, rgbToHex(rgb))
														}
													/>
													<button
														type="button"
														class="flex size-8 items-center justify-center rounded-lg text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12"
														onClick={() => setBrandColor(key, null)}
													>
														<IconLucideTrash2 class="size-4" />
													</button>
												</>
											)}
										</Show>
									</div>
								</div>
							);
						}}
					</For>
				</div>
			</DialogContent>
		</Dialog.Root>
	);
}

export function OrganizationDropdown() {
	const organizationSelection = createSelectedOrganization();
	const [settingsOrganizationId, setSettingsOrganizationId] = createSignal<
		string | null
	>(null);

	const selectedOrganization = organizationSelection.selectedOrganization;
	const settingsOrganization = createMemo(() => {
		const id = settingsOrganizationId();
		return (
			organizationSelection
				.organizations()
				.find((organization) => organization.id === id) ?? null
		);
	});

	const signedIn = createMemo(() => organizationSelection.signedIn());
	const triggerLabel = createMemo(() => {
		const availability = organizationSelection.availability();
		if (availability === "available") {
			return selectedOrganization()?.name ?? "Organization";
		}
		if (availability === "loading") return "Loading...";
		if (availability === "unavailable") return "Organization";
		return "Sign in";
	});
	const fallbackTitle = createMemo(() => {
		const availability = organizationSelection.availability();
		if (availability === "loading") return "Loading organizations";
		if (availability === "unavailable") return "Unable to load organizations";
		return "Organization branding requires sign in";
	});
	const fallbackDescription = createMemo(() => {
		const availability = organizationSelection.availability();
		if (availability === "loading") {
			return "Fetching organization branding from Cap web.";
		}
		if (availability === "unavailable") {
			return "Organization branding uses live Cap web data. Connect to Cap web to select an organization and use its colours.";
		}
		return "Sign in to select an organization, edit brand colours, and use those colours in Studio.";
	});

	const selectOrganization = (organization: DesktopOrganization) => {
		void organizationSelection
			.setSelectedOrganizationId(organization.id)
			.catch(console.error);
	};

	const retryOrganizations = () => {
		void organizationSelection.refresh().catch(console.error);
	};

	const saved = (organization: DesktopOrganization) => {
		void organizationSelection
			.setSelectedOrganizationId(organization.id)
			.catch(console.error);
	};

	return (
		<>
			<KDropdownMenu gutter={8} placement="bottom">
				<EditorButton<typeof KDropdownMenu.Trigger>
					as={KDropdownMenu.Trigger}
					leftIcon={<IconLucideBuilding2 class="size-4" />}
					rightIcon={<IconCapChevronDown />}
				>
					<span class="max-w-32 truncate">{triggerLabel()}</span>
				</EditorButton>
				<KDropdownMenu.Portal>
					<Suspense>
						<PopperContent<typeof KDropdownMenu.Content>
							as={KDropdownMenu.Content}
							class={cx("w-72 max-h-80", topCenterAnimateClasses)}
						>
							<Show
								when={signedIn()}
								fallback={
									<div class="p-3">
										<div class="flex flex-col gap-3">
											<div class="flex flex-col gap-1">
												<span class="text-sm font-medium text-gray-12">
													{fallbackTitle()}
												</span>
												<span class="text-xs leading-5 text-gray-11">
													{fallbackDescription()}
												</span>
											</div>
											<Show
												when={
													organizationSelection.availability() === "signed-out"
												}
											>
												<SignInButton class="w-full justify-center">
													Sign In
												</SignInButton>
											</Show>
											<Show
												when={
													organizationSelection.availability() === "unavailable"
												}
											>
												<Button
													variant="gray"
													class="w-full gap-1.5"
													onClick={retryOrganizations}
													disabled={organizationSelection.refreshing()}
												>
													<IconLucideRefreshCw class="size-4" />
													Retry
												</Button>
											</Show>
										</div>
									</div>
								}
							>
								<MenuItemList<typeof KDropdownMenu.Group>
									as={KDropdownMenu.Group}
									class="max-h-56 overflow-y-auto"
								>
									<For
										each={organizationSelection.organizations()}
										fallback={
											<div class="py-1 text-center text-sm text-gray-11">
												No organizations
											</div>
										}
									>
										{(organization) => (
											<DropdownItem
												class="h-10"
												onSelect={() => selectOrganization(organization)}
											>
												<OrganizationAvatar organization={organization} />
												<span class="min-w-0 flex-1 truncate">
													{organization.name}
												</span>
												<Show
													when={selectedOrganization()?.id === organization.id}
												>
													<IconLucideCheck class="size-4 text-blue-500" />
												</Show>
											</DropdownItem>
										)}
									</For>
								</MenuItemList>
								<Show when={selectedOrganization()?.canEditBrand}>
									<MenuItemList<typeof KDropdownMenu.Group>
										as={KDropdownMenu.Group}
										class="border-t"
									>
										<DropdownItem
											onSelect={() =>
												setSettingsOrganizationId(
													selectedOrganization()?.id ?? null,
												)
											}
										>
											<IconLucidePalette class="size-4" />
											Brand settings
										</DropdownItem>
									</MenuItemList>
								</Show>
							</Show>
						</PopperContent>
					</Suspense>
				</KDropdownMenu.Portal>
			</KDropdownMenu>

			<BrandSettingsDialog
				open={settingsOrganizationId() !== null}
				organization={settingsOrganization()}
				onOpenChange={(open) => {
					if (!open) setSettingsOrganizationId(null);
				}}
				onSaved={saved}
			/>
		</>
	);
}

export default OrganizationDropdown;
