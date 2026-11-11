import {
	BarChart3,
	CreditCard,
	KeyRound,
	LayoutGrid,
	type LucideIcon,
	Settings,
	Video,
} from "lucide-react";
import { INFRA_SECTIONS, type InfraSection } from "@/lib/infra-routes";

const icons: Record<InfraSection, LucideIcon> = {
	"": LayoutGrid,
	videos: Video,
	usage: BarChart3,
	billing: CreditCard,
	keys: KeyRound,
	settings: Settings,
};

export const infraNavItems = INFRA_SECTIONS.map((section) => ({
	slug: section.slug,
	name: section.name,
	icon: icons[section.slug],
}));
