import { Button } from "@cap/ui-solid";
import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query";
import { createSignal, For, Show, Suspense } from "solid-js";
import { commands } from "~/utils/tauri";
import { apiClient, protectedHeaders } from "~/utils/web-api";

interface GoogleDriveConfig {
	id: string;
	email: string | null;
	folderId: string | null;
	folderName: string | null;
	connected: boolean;
}

interface DriveFolder {
	id: string;
	name: string;
}

export default function GoogleDriveConfigPage() {
	const queryClient = useQueryClient();
	const [showFolderSelector, setShowFolderSelector] = createSignal(false);
	const [newFolderName, setNewFolderName] = createSignal("");

	const configQuery = useQuery(() => ({
		queryKey: ["googleDriveConfig"],
		queryFn: async () => {
			const response = await apiClient.desktop.getGoogleDriveConfig({
				headers: await protectedHeaders(),
			});
			if (response.status !== 200) throw new Error("Failed to fetch config");
			return response.body.config;
		},
	}));

	const foldersQuery = useQuery(() => ({
		queryKey: ["googleDriveFolders"],
		queryFn: async () => {
			const response = await apiClient.desktop.getGoogleDriveFolders({
				headers: await protectedHeaders(),
			});
			if (response.status !== 200) throw new Error("Failed to fetch folders");
			return response.body.folders;
		},
		enabled: !!configQuery.data?.connected && showFolderSelector(),
	}));

	const connectMutation = useMutation(() => ({
		mutationFn: async () => {
			const response = await apiClient.desktop.getGoogleDriveAuthUrl({
				headers: await protectedHeaders(),
			});
			if (response.status !== 200) throw new Error("Failed to get auth URL");

			const authUrl = response.body.authUrl;

			return new Promise<string>((resolve, reject) => {
				const handleMessage = async (event: MessageEvent) => {
					if (event.data?.type === "google-drive-auth-success") {
						window.removeEventListener("message", handleMessage);
						resolve(event.data.code);
					} else if (event.data?.type === "google-drive-auth-error") {
						window.removeEventListener("message", handleMessage);
						reject(new Error(event.data.error));
					}
				};

				window.addEventListener("message", handleMessage);

				const popup = window.open(
					authUrl,
					"google-drive-auth",
					"width=600,height=700,scrollbars=yes",
				);

				if (!popup) {
					window.removeEventListener("message", handleMessage);
					reject(new Error("Popup blocked"));
				}

				const checkClosed = setInterval(() => {
					if (popup?.closed) {
						clearInterval(checkClosed);
						window.removeEventListener("message", handleMessage);
					}
				}, 1000);
			});
		},
		onSuccess: async (code) => {
			const response = await apiClient.desktop.exchangeGoogleDriveCode({
				body: { code },
				headers: await protectedHeaders(),
			});
			if (response.status !== 200) throw new Error("Failed to exchange code");
			await queryClient.invalidateQueries({ queryKey: ["googleDriveConfig"] });
			await commands.globalMessageDialog(
				"Google Drive connected successfully!",
			);
		},
		onError: async (error) => {
			await commands.globalMessageDialog(
				`Failed to connect Google Drive: ${error.message}`,
			);
		},
	}));

	const disconnectMutation = useMutation(() => ({
		mutationFn: async () => {
			const response = await apiClient.desktop.deleteGoogleDriveConfig({
				headers: await protectedHeaders(),
			});
			if (response.status !== 200) throw new Error("Failed to disconnect");
			return response;
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["googleDriveConfig"] });
			await commands.globalMessageDialog(
				"Google Drive disconnected successfully",
			);
		},
	}));

	const setFolderMutation = useMutation(() => ({
		mutationFn: async (folder: { id: string; name: string } | null) => {
			const response = await apiClient.desktop.setGoogleDriveFolder({
				body: {
					folderId: folder?.id ?? null,
					folderName: folder?.name ?? null,
				},
				headers: await protectedHeaders(),
			});
			if (response.status !== 200) throw new Error("Failed to set folder");
			return response;
		},
		onSuccess: async () => {
			setShowFolderSelector(false);
			await queryClient.invalidateQueries({ queryKey: ["googleDriveConfig"] });
			await commands.globalMessageDialog("Folder updated successfully");
		},
	}));

	const createFolderMutation = useMutation(() => ({
		mutationFn: async (name: string) => {
			const response = await apiClient.desktop.createGoogleDriveFolder({
				body: { name },
				headers: await protectedHeaders(),
			});
			if (response.status !== 200) throw new Error("Failed to create folder");
			return response.body.folder;
		},
		onSuccess: async (folder) => {
			setNewFolderName("");
			await queryClient.invalidateQueries({ queryKey: ["googleDriveFolders"] });
			await setFolderMutation.mutateAsync(folder);
		},
	}));

	return (
		<div class="flex flex-col p-4 h-full">
			<div class="rounded-xl border bg-gray-2 border-gray-4 custom-scroll">
				<div class="flex-1">
					<Suspense
						fallback={
							<div class="flex justify-center items-center w-full h-screen">
								<IconCapLogo class="animate-spin size-16" />
							</div>
						}
					>
						<div class="p-4 space-y-4 animate-in fade-in">
							<div class="pb-4 border-b border-gray-3">
								<div class="flex gap-3 items-center mb-2">
									<IconLucideHardDrive class="size-8" />
									<h2 class="text-lg font-medium text-gray-12">Google Drive</h2>
								</div>
								<p class="text-sm text-gray-11">
									Connect your Google Drive to store and serve your screen
									recordings directly from your Drive. Files will be uploaded to
									a folder you choose, and shareable links will serve content
									from Google Drive.
								</p>
							</div>

							<Show
								when={configQuery.data?.connected}
								fallback={
									<div class="space-y-4">
										<div class="p-3 rounded-lg bg-gray-3">
											<p class="text-sm text-gray-11">
												Click the button below to connect your Google account
												and authorize Cap to store recordings in your Drive.
											</p>
										</div>

										<Button
											variant="primary"
											onClick={() => connectMutation.mutate()}
											disabled={connectMutation.isPending}
											class="w-full"
										>
											{connectMutation.isPending
												? "Connecting..."
												: "Connect Google Drive"}
										</Button>
									</div>
								}
							>
								<div class="space-y-4">
									<div class="flex items-center gap-2 p-3 rounded-lg bg-green-3">
										<IconLucideCheck class="flex-shrink-0 size-5 text-green-11" />
										<div class="flex-1">
											<p class="text-sm font-medium text-green-12">Connected</p>
											<Show when={configQuery.data?.email}>
												<p class="text-xs text-green-11">
													{configQuery.data?.email}
												</p>
											</Show>
										</div>
									</div>

									<div class="space-y-2">
										<label class="text-[13px] text-gray-12">
											Storage Folder
										</label>
										<div class="flex gap-2 items-center">
											<div class="flex-1 px-3 py-2 rounded-lg border border-transparent bg-gray-3">
												<span class="text-sm text-gray-11">
													{configQuery.data?.folderName || "Root (My Drive)"}
												</span>
											</div>
											<Button
												variant="gray"
												onClick={() => {
													setShowFolderSelector(!showFolderSelector());
													if (!showFolderSelector()) {
														queryClient.invalidateQueries({
															queryKey: ["googleDriveFolders"],
														});
													}
												}}
											>
												{showFolderSelector() ? "Cancel" : "Change"}
											</Button>
										</div>
									</div>

									<Show when={showFolderSelector()}>
										<div class="p-4 space-y-3 rounded-lg border bg-gray-3 border-gray-4">
											<p class="text-sm font-medium text-gray-12">
												Select a folder
											</p>

											<Show
												when={!foldersQuery.isLoading}
												fallback={
													<div class="flex justify-center py-4">
														<IconCapLogo class="animate-spin size-6" />
													</div>
												}
											>
												<div class="overflow-y-auto max-h-48 space-y-1">
													<button
														type="button"
														onClick={() => setFolderMutation.mutate(null)}
														class={`w-full px-3 py-2 text-left text-sm rounded-lg transition-colors ${
															!configQuery.data?.folderId
																? "bg-blue-9 text-white"
																: "hover:bg-gray-4 text-gray-12"
														}`}
													>
														📁 Root (My Drive)
													</button>
													<For each={foldersQuery.data}>
														{(folder) => (
															<button
																type="button"
																onClick={() => setFolderMutation.mutate(folder)}
																class={`w-full px-3 py-2 text-left text-sm rounded-lg transition-colors ${
																	configQuery.data?.folderId === folder.id
																		? "bg-blue-9 text-white"
																		: "hover:bg-gray-4 text-gray-12"
																}`}
															>
																📁 {folder.name}
															</button>
														)}
													</For>
												</div>

												<div class="pt-3 border-t border-gray-4">
													<p class="mb-2 text-xs text-gray-11">
														Or create a new folder:
													</p>
													<div class="flex gap-2">
														<input
															type="text"
															value={newFolderName()}
															onInput={(e) =>
																setNewFolderName(e.currentTarget.value)
															}
															placeholder="New folder name"
															class="flex-1 px-3 py-2 text-sm rounded-lg border border-transparent outline-none bg-gray-2 focus:border-gray-8"
														/>
														<Button
															variant="primary"
															size="sm"
															onClick={() =>
																createFolderMutation.mutate(newFolderName())
															}
															disabled={
																!newFolderName() ||
																createFolderMutation.isPending
															}
														>
															{createFolderMutation.isPending
																? "..."
																: "Create"}
														</Button>
													</div>
												</div>
											</Show>
										</div>
									</Show>
								</div>
							</Show>
						</div>
					</Suspense>
				</div>
			</div>
			<div class="flex-shrink-0 mt-5">
				<Show when={configQuery.data?.connected}>
					<fieldset
						class="flex justify-between items-center"
						disabled={disconnectMutation.isPending}
					>
						<Button
							variant="destructive"
							onClick={() => disconnectMutation.mutate()}
						>
							{disconnectMutation.isPending
								? "Disconnecting..."
								: "Disconnect Google Drive"}
						</Button>
					</fieldset>
				</Show>
			</div>
		</div>
	);
}
