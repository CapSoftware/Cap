import { Select as KSelect } from "@kobalte/core/select";
import { createSignal, Show } from "solid-js";
import Tooltip from "~/components/Tooltip";
import IconLucideExternalLink from "~icons/lucide/external-link";
import { useEditorContext } from "./context";
import {
	EditorButton,
	MenuItem,
	MenuItemList,
	PopperContent,
	topLeftAnimateClasses,
} from "./ui";

function ShareButton() {
	const {
		meta,
		project,
		customDomain,
		setEditorState,
		setDialog,
		exportState,
		setExportState,
	} = useEditorContext();
	const hasTransparentBackground = () => {
		const source = project.background.source;
		return source.type === "color" && (source.alpha ?? 255) < 255;
	};

	return (
		<div class="relative">
			<Show when={meta().sharing}>
				{(sharing) => {
					const normalUrl = () => new URL(sharing().link);
					const customUrl = () =>
						customDomain.data?.custom_domain &&
						customDomain.data?.domain_verified
							? new URL(`${customDomain.data.custom_domain}/s/${sharing().id}`)
							: null;
					const [preferCustom, setPreferCustom] = createSignal(true);
					const selectedUrl = () =>
						(preferCustom() && customUrl()) || normalUrl();
					const normalLink = () => `${normalUrl().host}${normalUrl().pathname}`;
					const customLink = () => {
						const url = customUrl();
						return url ? `${url.host}${url.pathname}` : normalLink();
					};
					const linkToDisplay = () =>
						`${selectedUrl().host}${selectedUrl().pathname}`;

					const [copyPressed, setCopyPressed] = createSignal(false);

					const copyLink = () => {
						navigator.clipboard.writeText(selectedUrl().href);
						setCopyPressed(true);
						setTimeout(() => {
							setCopyPressed(false);
						}, 2000);
					};

					return (
						<div class="flex gap-1 items-center">
							<EditorButton
								class="h-[30px] px-3 text-ed-accent bg-ed-accent/10 border border-ed-accent/25 hover:bg-ed-accent/20"
								disabled={hasTransparentBackground()}
								tooltipText={
									hasTransparentBackground()
										? "Share links require a background without transparency"
										: "Upload your latest edit to the same link"
								}
								onClick={() => {
									setEditorState("timeline", "selection", null);
									if (exportState.type === "done")
										setExportState({ type: "idle" });
									setDialog({
										type: "export",
										open: true,
										destination: "link",
									});
								}}
								leftIcon={<IconCapUpload />}
							>
								Reupload
							</EditorButton>
							<Tooltip content="Open link">
								<div class="flex flex-row gap-1.5 items-center px-2.5 h-7 rounded-[7px] transition-colors duration-100 bg-ed-ctl hover:bg-ed-ctl-hover">
									<a
										href={selectedUrl().href}
										target="_blank"
										rel="noreferrer"
										title={linkToDisplay() ?? "Open link"}
										aria-label="Open recording link"
										class="w-full truncate max-w-[200px] max-[1400px]:w-4 max-[1400px]:shrink-0"
									>
										<span class="text-xs text-ed-text-2 max-[1400px]:hidden">
											{linkToDisplay()}
										</span>
										<IconLucideExternalLink class="hidden size-4 text-ed-text-2 max-[1400px]:block" />
									</a>
									<Show
										when={
											customDomain.data?.custom_domain &&
											customDomain.data?.domain_verified
										}
									>
										<Tooltip content="Select link">
											<KSelect
												value={linkToDisplay()}
												onChange={(value) =>
													value && setPreferCustom(value === customLink())
												}
												options={[customLink(), normalLink()].filter(
													(link) => link !== linkToDisplay(),
												)}
												multiple={false}
												itemComponent={(props) => (
													<MenuItem<typeof KSelect.Item>
														as={KSelect.Item}
														item={props.item}
													>
														<KSelect.ItemLabel class="flex-1 text-xs truncate">
															{props.item.rawValue}
														</KSelect.ItemLabel>
													</MenuItem>
												)}
												placement="bottom-end"
												gutter={4}
											>
												<KSelect.Trigger class="flex justify-center items-center transition-colors duration-200 rounded-md size-5 text-ed-text-2 bg-ed-ctl-hover hover:bg-ed-ctl-active group focus:outline-hidden focus-visible:outline-hidden">
													<KSelect.Icon>
														<IconCapChevronDown class="size-4 transition-transform duration-200 group-data-expanded:rotate-180" />
													</KSelect.Icon>
												</KSelect.Trigger>
												<KSelect.Portal>
													<PopperContent<typeof KSelect.Content>
														as={KSelect.Content}
														class={topLeftAnimateClasses}
													>
														<MenuItemList<typeof KSelect.Listbox>
															as={KSelect.Listbox}
															class="w-[236px]"
														/>
													</PopperContent>
												</KSelect.Portal>
											</KSelect>
										</Tooltip>
									</Show>
									<Tooltip content="Copy link">
										<div
											class="flex justify-center items-center transition-colors duration-200 rounded-md size-5 text-ed-text-2 bg-ed-ctl-hover hover:bg-ed-ctl-active"
											onClick={copyLink}
										>
											{!copyPressed() ? (
												<IconCapCopy class="size-3" />
											) : (
												<IconLucideCheck class="size-3 svgpathanimation" />
											)}
										</div>
									</Tooltip>
								</div>
							</Tooltip>
						</div>
					);
				}}
			</Show>
		</div>
	);
}

export default ShareButton;
