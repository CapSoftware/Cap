"use client";

import { Button } from "@cap/ui";
import { faDownload } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ChevronDown } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useId, useRef, useState } from "react";
import { ChromeRecorderButton } from "@/components/ChromeRecorderButton";
import { CHROME_EXTENSION_BUTTON_CLASS } from "@/lib/chrome-extension";
import { FREE_PLAN_MAX_RECORDING_MS } from "../components/web-recorder-dialog/web-recorder-constants";
import { WebRecorderDialog } from "../components/web-recorder-dialog/web-recorder-dialog";

export const RecordVideoPage = () => {
	const checkingRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const openDesktop = useCallback(() => {
		let handled = false;
		const onChange = () => {
			handled = true;
			document.removeEventListener("visibilitychange", onChange);
			window.removeEventListener("pagehide", onChange);
			window.removeEventListener("blur", onChange);
		};
		document.addEventListener("visibilitychange", onChange, { once: true });
		window.addEventListener("pagehide", onChange, { once: true });
		window.addEventListener("blur", onChange, { once: true });

		window.location.href = "cap-desktop://";

		if (checkingRef.current) clearTimeout(checkingRef.current);
		checkingRef.current = setTimeout(() => {
			if (!handled && document.visibilityState === "visible") {
				document.removeEventListener("visibilitychange", onChange);
				window.removeEventListener("pagehide", onChange);
				window.removeEventListener("blur", onChange);
				window.location.assign("/download");
			}
		}, 1500);
	}, []);

	return (
		<div
			className="flex flex-col flex-1 justify-center items-center w-full h-full"
			style={{ scrollbarGutter: "stable" }}
		>
			<div className="w-full flex flex-col gap-3 justify-center items-center h-full text-center">
				<div className="w-full px-5">
					<div className="mx-auto w-full max-w-[560px] min-w-0">
						<div className="flex flex-col items-center">
							<p className="max-w-md text-gray-10 text-md">
								选择录制 Cap 的方式
							</p>
						</div>
						<div className="flex flex-wrap gap-3 justify-center items-center mt-4">
							<Button
								onClick={openDesktop}
								className="flex relative gap-2 justify-center items-center"
								variant="primary"
							>
								<FontAwesomeIcon className="size-3.5" icon={faDownload} />
								打开 Cap 桌面应用
							</Button>
							<p className="text-sm text-gray-10">或</p>
							<WebRecorderDialog />
							<ChromeRecorderButton
								size="sm"
								className={`${CHROME_EXTENSION_BUTTON_CLASS} font-medium`}
							/>
						</div>
						<FaqAccordion />
					</div>
				</div>
			</div>
		</div>
	);
};

const FaqAccordion = () => {
	const freeMinutes = Math.floor(FREE_PLAN_MAX_RECORDING_MS / 60000);
	const items = [
		{
			id: "what-is-cap",
			q: "什么是 Cap？",
			a: "Cap 是对屏幕、摄像头或两者的快速视频录制，可通过链接立即分享。",
		},
		{
			id: "how-it-works",
			q: "它如何工作？",
			a: "在兼容的浏览器中，录制内容会在录制时于后台上传；否则会先完成录制，并在停止后立即上传，让分享链接马上可用。",
		},
		{
			id: "browsers",
			q: "推荐使用哪些浏览器？",
			a: "建议使用 Google Chrome 或其他基于 Chromium 的浏览器，以获得最可靠的录制和上传体验。大多数现代浏览器均受支持，但具体功能可能有所不同。",
		},
		{
			id: "pip",
			q: "如何让摄像头画面保持可见？",
			a: "在兼容的浏览器中，选择摄像头会打开画中画窗口，并可在全屏录制时一并录入。建议使用全屏录制使其保持置顶。如果不支持捕获画中画，摄像头画面会保留在 Cap 录制器标签页中。",
		},
		{
			id: "what-can-i-record",
			q: "可以录制哪些内容？",
			a: "你可以录制整个屏幕、指定窗口、浏览器标签页，或仅录制摄像头。",
		},
		{
			id: "system-audio",
			q: "可以录制系统音频吗？",
			a: "浏览器会限制全系统音频捕获。建议使用 Cap 桌面应用以获得最佳效果。",
		},
		{
			id: "install",
			q: "需要安装应用吗？",
			a: `不需要，你可以直接在浏览器中录制。如需更长时间的录制、系统音频和高级编辑，请使用 Cap 桌面应用。免费套餐在浏览器中的单次录制最长为 ${freeMinutes} 分钟。`,
		},
	];

	return (
		<div className="mt-8 text-left">
			<div className="w-full min-w-0 divide-y divide-gray-4 rounded-lg border border-gray-4 bg-gray-2">
				{items.map((it) => (
					<AccordionItem key={it.id} title={it.q} content={it.a} />
				))}
			</div>
		</div>
	);
};

const AccordionItem = ({
	title,
	content,
}: {
	title: string;
	content: string;
}) => {
	const [open, setOpen] = useState(false);
	const contentId = useId();
	const headerId = useId();

	return (
		<div className="p-3 w-full">
			<button
				id={headerId}
				aria-controls={contentId}
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				type="button"
				className="flex w-full items-center justify-between gap-3 text-left"
			>
				<span className="text-sm font-medium text-gray-12">{title}</span>
				<ChevronDown
					className="size-4 shrink-0 text-gray-10 transition-transform duration-200"
					style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)" }}
				/>
			</button>
			<AnimatePresence initial={false}>
				{open && (
					<motion.section
						id={contentId}
						aria-labelledby={headerId}
						initial={{ opacity: 0, height: 0 }}
						animate={{ opacity: 1, height: "auto" }}
						exit={{ opacity: 0, height: 0 }}
						transition={{ duration: 0.18 }}
						className="overflow-hidden w-full"
					>
						<div className="pt-2 text-sm text-gray-10">{content}</div>
					</motion.section>
				)}
			</AnimatePresence>
		</div>
	);
};
