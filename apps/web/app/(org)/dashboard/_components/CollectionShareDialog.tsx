"use client";

import {
	Button,
	buttonVariants,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
	Select,
	Switch,
} from "@cap/ui";
import { PublicCollection } from "@cap/web-domain";
import {
	faArrowUpRightFromSquare,
	faCheck,
	faCopy,
	faGlobe,
	faLock,
	faUpload,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { useEffect, useId, useRef, useState } from "react";
import { useCopyCollectionLink } from "@/lib/public-collection-client";
import {
	PUBLIC_GRID_COLUMN_OPTIONS,
	PUBLIC_LAYOUT_OPTIONS,
	PUBLIC_LOGO_OPTIONS,
} from "@/lib/public-collection-settings";

type PublicPageSettings = PublicCollection.PublicPageSettings;
type PublicPageSettingsUpdate = PublicCollection.PublicPageSettingsUpdate;

const {
	PUBLIC_PAGE_TITLE_MAX_LENGTH,
	PUBLIC_PAGE_SUBTITLE_MAX_LENGTH,
	PUBLIC_PAGE_CTA_LABEL_MAX_LENGTH,
	PUBLIC_PAGE_CTA_URL_MAX_LENGTH,
} = PublicCollection;

const gridColumnSelectOptions = PUBLIC_GRID_COLUMN_OPTIONS.map((option) => ({
	value: String(option.value),
	label: option.label,
}));

interface CollectionShareDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	kind: "folder" | "space";
	collectionId: string;
	isPublic: boolean;
	isPro: boolean;
	isPending: boolean;
	settings: Required<PublicPageSettings>;
	onTogglePublic: (next: boolean) => void;
	onUpdateSettings: (patch: PublicPageSettingsUpdate) => void;
	onUploadLogo: (file: File) => void;
	onRemoveLogo: () => void;
	isUploadingLogo: boolean;
}

export const CollectionShareDialog = ({
	open,
	onOpenChange,
	kind,
	collectionId,
	isPublic,
	isPro,
	isPending,
	settings,
	onTogglePublic,
	onUpdateSettings,
	onUploadLogo,
	onRemoveLogo,
	isUploadingLogo,
}: CollectionShareDialogProps) => {
	const { url, copied, copy } = useCopyCollectionLink(collectionId);
	const displayUrl = url.replace(/^https?:\/\//, "");

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex flex-col p-0 w-[calc(100%-20px)] max-w-lg rounded-xl border bg-gray-2 border-gray-4 max-h-[90vh]">
				<DialogHeader
					icon={<FontAwesomeIcon icon={faGlobe} className="size-3.5" />}
					description={
						isPublic
							? `Anyone with the link can browse the public caps in this ${kind}.`
							: `Publish this ${kind} as a clean, browsable page you can share with anyone.`
					}
				>
					<DialogTitle>Share this {kind}</DialogTitle>
				</DialogHeader>

				<div className="overflow-y-auto flex-1 p-5 space-y-4 min-h-0">
					<div
						className={clsx(
							"flex gap-3 justify-between items-center p-3.5 rounded-xl border transition-colors",
							isPublic ? "border-blue-9 bg-gray-1" : "border-gray-4 bg-gray-1",
						)}
					>
						<div className="flex gap-3 items-center min-w-0">
							<div
								className={clsx(
									"flex justify-center items-center rounded-full transition-colors size-9 shrink-0",
									isPublic ? "text-blue-9 bg-blue-3" : "text-gray-11 bg-gray-3",
								)}
							>
								<FontAwesomeIcon
									icon={isPublic ? faGlobe : faLock}
									className="size-3.5"
								/>
							</div>
							<div className="min-w-0">
								<div className="flex gap-1.5 items-center">
									<p className="text-sm font-medium text-gray-12">
										Anyone with the link
									</p>
									{!isPro && (
										<span className="rounded-full bg-blue-11 px-1.5 py-0.5 text-[10px] font-medium leading-none text-white">
											Pro
										</span>
									)}
								</div>
								<p className="text-xs text-gray-10">
									{isPublic
										? "Public — anyone with the link can view"
										: "Private — only members can view"}
								</p>
							</div>
						</div>
						<Switch
							checked={isPublic}
							disabled={isPending}
							onCheckedChange={onTogglePublic}
						/>
					</div>

					{isPublic && (
						<>
							<div className="relative">
								<Input
									type="text"
									readOnly
									value={url}
									onFocus={(e) => e.currentTarget.select()}
									className="pr-11 font-mono text-xs"
								/>
								<button
									type="button"
									onClick={copy}
									aria-label="Copy public link"
									className="flex absolute right-1.5 top-1/2 justify-center items-center rounded-lg transition-colors -translate-y-1/2 size-8 text-gray-11 hover:bg-gray-3 hover:text-gray-12"
								>
									<FontAwesomeIcon
										icon={copied ? faCheck : faCopy}
										className={clsx("size-3.5", copied && "text-blue-11")}
									/>
								</button>
							</div>

							<FieldGroup title="Page header">
								<TextField
									label="Title"
									value={settings.title}
									placeholder="Defaults to the collection name"
									maxLength={PUBLIC_PAGE_TITLE_MAX_LENGTH}
									disabled={isPending}
									onCommit={(value) => onUpdateSettings({ title: value })}
								/>
								<TextField
									label="Subtitle"
									value={settings.subtitle}
									placeholder="Add a short description"
									maxLength={PUBLIC_PAGE_SUBTITLE_MAX_LENGTH}
									disabled={isPending}
									onCommit={(value) => onUpdateSettings({ subtitle: value })}
								/>
								<div className="space-y-1.5">
									<span className="text-sm text-gray-12">Logo</span>
									<Select
										size="default"
										className="w-full"
										value={settings.logoMode}
										placeholder="Logo"
										options={PUBLIC_LOGO_OPTIONS}
										onValueChange={(value) =>
											onUpdateSettings({
												logoMode: value as PublicPageSettings["logoMode"],
											})
										}
									/>
									{settings.logoMode === "custom" && (
										<LogoUploader
											hasLogo={Boolean(settings.logoUrl)}
											isUploading={isUploadingLogo}
											onUpload={onUploadLogo}
											onRemove={onRemoveLogo}
										/>
									)}
								</div>

								<div className="divide-y divide-gray-4">
									<SettingRow label="Show title">
										<Switch
											checked={!settings.hideTitle}
											disabled={isPending}
											onCheckedChange={(checked) =>
												onUpdateSettings({ hideTitle: !checked })
											}
										/>
									</SettingRow>
									<SettingRow label="Show copy link button">
										<Switch
											checked={!settings.hideCopyLink}
											disabled={isPending}
											onCheckedChange={(checked) =>
												onUpdateSettings({ hideCopyLink: !checked })
											}
										/>
									</SettingRow>
								</div>
							</FieldGroup>

							<FieldGroup
								title="Call to action"
								description="Add a button to the page header."
							>
								<TextField
									label="Button label"
									value={settings.ctaLabel}
									placeholder="e.g. Visit our website"
									maxLength={PUBLIC_PAGE_CTA_LABEL_MAX_LENGTH}
									disabled={isPending}
									onCommit={(value) => onUpdateSettings({ ctaLabel: value })}
								/>
								<TextField
									label="Button link"
									value={settings.ctaUrl}
									placeholder="https://example.com"
									maxLength={PUBLIC_PAGE_CTA_URL_MAX_LENGTH}
									disabled={isPending}
									onCommit={(value) => onUpdateSettings({ ctaUrl: value })}
								/>
							</FieldGroup>

							<FieldGroup title="Layout">
								<div className="divide-y divide-gray-4">
									<SettingRow label="Style" description="How caps are arranged">
										<Select
											size="sm"
											value={settings.layout}
											placeholder="Layout"
											options={PUBLIC_LAYOUT_OPTIONS}
											onValueChange={(value) =>
												onUpdateSettings({
													layout: value as PublicPageSettings["layout"],
												})
											}
										/>
									</SettingRow>

									{settings.layout === "grid" && (
										<SettingRow
											label="Columns"
											description="Caps shown per row"
										>
											<Select
												size="sm"
												value={String(settings.gridColumns)}
												placeholder="Columns"
												options={gridColumnSelectOptions}
												onValueChange={(value) =>
													onUpdateSettings({
														gridColumns: Number(
															value,
														) as PublicPageSettings["gridColumns"],
													})
												}
											/>
										</SettingRow>
									)}
								</div>
							</FieldGroup>
						</>
					)}
				</div>

				<DialogFooter className="sm:justify-between">
					{isPublic ? (
						<a
							href={url}
							target="_blank"
							rel="noreferrer"
							className={buttonVariants({ variant: "gray", size: "sm" })}
						>
							<FontAwesomeIcon
								icon={faArrowUpRightFromSquare}
								className="size-3"
							/>
							Open page
						</a>
					) : (
						<span className="hidden text-xs truncate text-gray-9 sm:block">
							{displayUrl}
						</span>
					)}
					<Button
						type="button"
						variant="dark"
						size="sm"
						onClick={() => onOpenChange(false)}
					>
						Done
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

function LogoUploader({
	hasLogo,
	isUploading,
	onUpload,
	onRemove,
}: {
	hasLogo: boolean;
	isUploading: boolean;
	onUpload: (file: File) => void;
	onRemove: () => void;
}) {
	const inputRef = useRef<HTMLInputElement>(null);

	return (
		<div className="pt-1 space-y-1.5">
			<div className="flex gap-2 items-center">
				<input
					ref={inputRef}
					type="file"
					accept="image/png,image/jpeg,image/svg+xml,image/webp"
					className="hidden"
					onChange={(e) => {
						const file = e.target.files?.[0];
						if (file) onUpload(file);
						e.currentTarget.value = "";
					}}
				/>
				<Button
					type="button"
					variant="gray"
					size="sm"
					disabled={isUploading}
					spinner={isUploading}
					onClick={() => inputRef.current?.click()}
				>
					{!isUploading && (
						<FontAwesomeIcon icon={faUpload} className="size-3" />
					)}
					{hasLogo ? "Replace logo" : "Upload logo"}
				</Button>
				{hasLogo && (
					<Button
						type="button"
						variant="gray"
						size="sm"
						disabled={isUploading}
						onClick={onRemove}
					>
						Remove
					</Button>
				)}
			</div>
			<p className="text-xs text-gray-10">PNG, JPEG, SVG or WebP, up to 1MB.</p>
		</div>
	);
}

function FieldGroup({
	title,
	description,
	children,
}: {
	title: string;
	description?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="rounded-xl border border-gray-4 bg-gray-1 p-3.5">
			<p className="text-[11px] font-medium tracking-wide uppercase text-gray-9">
				{title}
			</p>
			{description && (
				<p className="mt-0.5 text-xs text-gray-10">{description}</p>
			)}
			<div className="mt-3 space-y-3">{children}</div>
		</div>
	);
}

function TextField({
	label,
	value,
	placeholder,
	maxLength,
	disabled,
	onCommit,
}: {
	label: string;
	value: string;
	placeholder?: string;
	maxLength?: number;
	disabled?: boolean;
	onCommit: (value: string) => void;
}) {
	const id = useId();
	const [draft, setDraft] = useState(value);

	useEffect(() => setDraft(value), [value]);

	const commit = () => {
		const next = draft.trim();
		setDraft(next);
		if (next === value) return;
		onCommit(next);
	};

	return (
		<div className="space-y-1.5">
			<label htmlFor={id} className="text-sm text-gray-12">
				{label}
			</label>
			<Input
				id={id}
				type="text"
				value={draft}
				placeholder={placeholder}
				maxLength={maxLength}
				disabled={disabled}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === "Enter") e.currentTarget.blur();
				}}
			/>
		</div>
	);
}

function SettingRow({
	label,
	description,
	children,
}: {
	label: string;
	description?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex gap-3 justify-between items-center py-3 first:pt-0 last:pb-0">
			<div className="min-w-0">
				<p className="text-sm text-gray-12">{label}</p>
				{description && <p className="text-xs text-gray-10">{description}</p>}
			</div>
			{children}
		</div>
	);
}
