"use client";

import { Button } from "@cap/ui";
import { faDownload } from "@fortawesome/free-solid-svg-icons/faDownload";
import { useCapChromeExtension } from "hooks/useCapChromeExtension";
import { ChromeRecorderButton } from "@/components/ChromeRecorderButton";
import { FontAwesomeIcon } from "@/components/FontAwesomeIcon";
import { CHROME_EXTENSION_BUTTON_CLASS } from "@/lib/chrome-extension";
import { useRive } from "@/lib/rive";
import { useTheme } from "../../Contexts";
import { UploadCapButton } from "./UploadCapButton";
import { WebRecorderDialog } from "./web-recorder-dialog/web-recorder-dialog";

interface EmptyCapStateProps {
	userName?: string;
}

export const EmptyCapState: React.FC<EmptyCapStateProps> = ({ userName }) => {
	const { theme } = useTheme();
	const { isChromeBrowser, isInstalled } = useCapChromeExtension();
	const showChromeButton = isChromeBrowser || isInstalled;
	const { RiveComponent: EmptyCap } = useRive({
		src: "/rive/main.riv",
		artboard: theme === "light" ? "empty" : "darkempty",
		autoplay: true,
	});
	return (
		<div className="flex flex-col flex-1 justify-center items-center w-full h-full">
			<div className="flex flex-col gap-3 justify-center items-center h-full text-center">
				<div className="mx-auto w-full mb-10 max-w-[450px] flex justify-center items-center">
					<EmptyCap key={`${theme}empty-cap`} className="h-[150px] w-[400px]" />
				</div>
				<div className="flex flex-col items-center px-5">
					<p className="mb-1 text-xl font-semibold tracking-tight text-gray-12">
						Hey{userName ? ` ${userName}` : ""}! Record your first Cap
					</p>
					<p className="max-w-md text-sm text-gray-10">
						Craft your narrative with Cap - get projects done quicker.
					</p>
				</div>
				<div className="flex flex-wrap gap-2 justify-center items-center mt-4">
					<Button
						href="/download"
						className="flex relative gap-2 justify-center items-center px-4 h-9"
						size="sm"
						variant="dark"
					>
						<FontAwesomeIcon className="size-3.5" icon={faDownload} />
						Download Cap
					</Button>
					<WebRecorderDialog />
					{showChromeButton && (
						<ChromeRecorderButton
							className={`${CHROME_EXTENSION_BUTTON_CLASS} font-medium h-9 px-4`}
						/>
					)}
					<UploadCapButton size="sm" />
				</div>
			</div>
		</div>
	);
};
