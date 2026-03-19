"use client";

import { faUpload } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import Link from "next/link";

export const ImportPage = () => {
	return (
		<div className="flex flex-col w-full h-full">
			<div className="mb-8">
				<h1 className="text-2xl font-medium text-gray-12">Import</h1>
				<p className="mt-1 text-sm text-gray-10">
					Import videos from external sources or upload from your device.
				</p>
			</div>

			<div className="grid grid-cols-1 gap-5 sm:grid-cols-2 max-w-2xl">
				<Link
					href="/dashboard/import/file"
					className="group relative flex overflow-hidden flex-col w-full rounded-xl border border-gray-3 bg-gray-1 transition-all duration-200 hover:border-blue-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-8"
				>
					<div className="flex items-center justify-center w-full h-32 bg-gray-3 transition-colors duration-200 group-hover:bg-gray-4">
						<div className="flex items-center justify-center size-14 rounded-full bg-gray-1 text-gray-10 transition-all duration-200 group-hover:text-gray-12 group-hover:scale-110">
							<FontAwesomeIcon className="size-5" icon={faUpload} />
						</div>
					</div>
					<div className="flex flex-col gap-1 p-4">
						<p className="text-sm font-medium text-gray-12 text-left">
							Upload File
						</p>
						<p className="text-xs text-gray-10 text-left">
							Upload a video file from your device
						</p>
					</div>
				</Link>

				<Link
					href="/dashboard/import/loom"
					className="group relative flex overflow-hidden flex-col w-full rounded-xl border border-gray-3 bg-gray-1 transition-all duration-200 hover:border-blue-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-8"
				>
					<div className="flex items-center justify-center w-full h-32 bg-gray-3 transition-colors duration-200 group-hover:bg-gray-4">
						<div className="flex items-center justify-center size-14 rounded-full bg-gray-1 transition-all duration-200 group-hover:scale-110">
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="22"
								height="22"
								viewBox="0 0 16 16"
								fill="none"
								role="img"
								aria-label="Loom"
							>
								<path
									fill="#625DF5"
									d="M15 7.222h-4.094l3.546-2.047-.779-1.35-3.545 2.048 2.046-3.546-1.349-.779L8.78 5.093V1H7.22v4.094L5.174 1.548l-1.348.779 2.046 3.545-3.545-2.046-.779 1.348 3.546 2.047H1v1.557h4.093l-3.545 2.047.779 1.35 3.545-2.047-2.047 3.545 1.35.779 2.046-3.546V15h1.557v-4.094l2.047 3.546 1.349-.779-2.047-3.546 3.545 2.047.779-1.349-3.545-2.046h4.093L15 7.222zm-7 2.896a2.126 2.126 0 110-4.252 2.126 2.126 0 010 4.252z"
								/>
							</svg>
						</div>
					</div>
					<div className="flex flex-col gap-1 p-4">
						<p className="text-sm font-medium text-gray-12 text-left">Loom</p>
						<p className="text-xs text-gray-10 text-left">
							Import a video from a Loom share link
						</p>
					</div>
				</Link>
			</div>
		</div>
	);
};
