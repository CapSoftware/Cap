"use client";

import { Button, Switch } from "@cap/ui";
import {
	faCheck,
	faCopy,
	faGlobe,
	faLock,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { useCopyCollectionLink } from "@/lib/public-collection-client";

interface PublicCollectionFieldProps {
	kind: "folder" | "space";
	enabled: boolean;
	onChange: (enabled: boolean) => void;
	isPro: boolean;
	onUpgrade: () => void;
	collectionId?: string;
	disabled?: boolean;
}

export const PublicCollectionField = ({
	kind,
	enabled,
	onChange,
	isPro,
	onUpgrade,
	collectionId,
	disabled,
}: PublicCollectionFieldProps) => {
	const { copied, copy } = useCopyCollectionLink(collectionId);

	return (
		<div
			className={clsx(
				"rounded-xl border transition-colors",
				enabled ? "border-blue-9 bg-gray-1" : "border-gray-4 bg-gray-1",
			)}
		>
			<div className="flex gap-3 justify-between items-center p-3.5">
				<div className="flex gap-3 items-center min-w-0">
					<div
						className={clsx(
							"flex justify-center items-center rounded-full transition-colors size-9 shrink-0",
							enabled ? "text-blue-9 bg-blue-3" : "text-gray-11 bg-gray-3",
						)}
					>
						<FontAwesomeIcon
							icon={enabled ? faGlobe : faLock}
							className="size-3.5"
						/>
					</div>
					<div className="min-w-0">
						<div className="flex gap-1.5 items-center">
							<p className="text-sm font-medium text-gray-12">
								Public collection link
							</p>
							{!isPro && (
								<span className="rounded-full bg-blue-11 px-1.5 py-0.5 text-[10px] font-medium leading-none text-white">
									Pro
								</span>
							)}
						</div>
						<p className="text-xs text-gray-10">
							Anyone with the link can browse public caps in this {kind}.
						</p>
					</div>
				</div>
				<Switch
					checked={enabled}
					disabled={disabled}
					onCheckedChange={(checked) => {
						if (checked && !isPro) {
							onUpgrade();
							return;
						}
						onChange(checked);
					}}
				/>
			</div>
			{enabled && collectionId && (
				<div className="px-3.5 pb-3.5">
					<Button
						type="button"
						size="sm"
						variant="gray"
						className="w-full"
						onClick={copy}
					>
						<FontAwesomeIcon
							icon={copied ? faCheck : faCopy}
							className={copied ? "size-3 text-blue-11" : "size-3"}
						/>
						{copied ? "Copied" : "Copy public link"}
					</Button>
				</div>
			)}
		</div>
	);
};
