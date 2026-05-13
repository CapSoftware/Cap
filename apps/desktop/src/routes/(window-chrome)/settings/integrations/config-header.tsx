import { Button } from "@cap/ui-solid";
import { useNavigate } from "@solidjs/router";
import IconLucideArrowLeft from "~icons/lucide/arrow-left";

export function IntegrationConfigHeader(props: { title: string }) {
	const navigate = useNavigate();

	return (
		<div class="flex shrink-0 justify-between items-center pb-3">
			<Button
				variant="gray"
				size="sm"
				class="gap-1.5"
				onClick={() => navigate("/settings/integrations")}
			>
				<IconLucideArrowLeft class="size-3.5" />
				Back
			</Button>
			<p class="text-sm font-medium text-gray-12">{props.title}</p>
		</div>
	);
}
