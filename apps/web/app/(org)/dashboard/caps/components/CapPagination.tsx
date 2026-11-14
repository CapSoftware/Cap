import {
	Pagination,
	PaginationContent,
	PaginationEllipsis,
	PaginationItem,
	PaginationLink,
	PaginationNext,
	PaginationPrevious,
} from "@cap/ui";
import Link from "next/link";
import { getPaginationItems } from "./pagination-items";

interface CapPaginationProps {
	currentPage: number;
	totalPages: number;
	hrefForPage?: (page: number) => string;
}

export const CapPagination: React.FC<CapPaginationProps> = ({
	currentPage,
	totalPages,
	hrefForPage = (page) => `/dashboard/caps?page=${page}`,
}) => {
	return (
		<Pagination>
			<PaginationContent className="flex-wrap">
				{currentPage > 1 && (
					<PaginationItem>
						<PaginationPrevious
							as={Link}
							className="h-10 bg-transparent hover:bg-gray-4"
							href={hrefForPage(currentPage - 1)}
						/>
					</PaginationItem>
				)}
				{getPaginationItems(currentPage, totalPages).map((item) =>
					typeof item === "string" ? (
						<PaginationEllipsis key={item} />
					) : (
						<PaginationItem key={item}>
							<PaginationLink
								as={Link}
								className={
									item === currentPage
										? "h-10 min-w-10"
										: "h-10 min-w-10 hover:bg-gray-3"
								}
								href={hrefForPage(item)}
								isActive={item === currentPage}
							>
								{item}
							</PaginationLink>
						</PaginationItem>
					),
				)}
				{currentPage < totalPages && (
					<PaginationItem>
						<PaginationNext
							as={Link}
							className="h-10 bg-transparent hover:bg-gray-4"
							href={hrefForPage(currentPage + 1)}
						/>
					</PaginationItem>
				)}
			</PaginationContent>
		</Pagination>
	);
};
