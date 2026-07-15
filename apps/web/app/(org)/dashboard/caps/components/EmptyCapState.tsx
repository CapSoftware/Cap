import { Button } from "@cap/ui";
import { faDownload } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ChromeRecorderButton } from "@/components/ChromeRecorderButton";
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
					<p className="mb-1 text-xl font-semibold text-gray-12">
						你好{userName ? `，${userName}` : ""}！录制你的第一个 Cap
					</p>
					<p className="max-w-md text-gray-10 text-md">
						用 Cap 清晰表达，加快项目进度。
					</p>
				</div>
				<div className="flex flex-wrap gap-3 justify-center items-center mt-4">
					<Button
						href="/download"
						className="flex relative gap-2 justify-center items-center"
						variant="primary"
					>
						<FontAwesomeIcon className="size-3.5" icon={faDownload} />
						下载 Cap
					</Button>
					<p className="text-sm text-gray-10">或</p>
					<WebRecorderDialog />
					<p className="text-sm text-gray-10">或</p>
					<ChromeRecorderButton
						className={`${CHROME_EXTENSION_BUTTON_CLASS} font-medium`}
					/>
					<p className="text-sm text-gray-10">或</p>
					<UploadCapButton />
				</div>
			</div>
		</div>
	);
};
