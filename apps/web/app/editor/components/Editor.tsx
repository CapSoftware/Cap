"use client";

import type { ProjectConfiguration } from "../types/project-config";
import { ConfigSidebar } from "./ConfigSidebar";
import { EditorProvider } from "./context";
import { Header } from "./Header";
import { Player } from "./Player";
import { Timeline } from "./Timeline";
import { useEditorShortcuts } from "./useEditorShortcuts";

interface VideoData {
	id: string;
	name: string;
	duration: number;
	width: number;
	height: number;
}

interface EditorProps {
	video: VideoData;
	videoUrl: string;
	initialConfig?: ProjectConfiguration;
}

function EditorContent({ videoId }: { videoId: string }) {
	useEditorShortcuts();

	return (
		<div className="flex flex-col h-screen bg-gray-3 overflow-hidden">
			<Header videoId={videoId} />
			<div className="flex flex-col lg:flex-row flex-1 gap-3 p-3 min-h-0 overflow-auto lg:overflow-hidden">
				<div className="flex flex-col flex-1 gap-3 min-h-0 min-w-0">
					<Player />
					<div className="h-32 sm:h-36 lg:h-40 shrink-0">
						<Timeline />
					</div>
				</div>
				<ConfigSidebar />
			</div>
		</div>
	);
}

export function Editor({ video, videoUrl, initialConfig }: EditorProps) {
	return (
		<EditorProvider
			video={video}
			videoUrl={videoUrl}
			initialConfig={initialConfig}
		>
			<EditorContent videoId={video.id} />
		</EditorProvider>
	);
}
