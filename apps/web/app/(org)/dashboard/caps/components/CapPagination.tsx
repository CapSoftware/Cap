import {
	Pagination,
	PaginationContent,
	PaginationEllipsis,
	PaginationItem,
	PaginationLink,
	PaginationNext,
	PaginationPrevious,
} from "@cap/ui";
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
							className="h-10 bg-transparent hover:bg-gray-4"
							href={hrefForPage(currentPage - 1)}
						/>
					</PaginationItem>
				)}
				{getPaginationItems(currentPage, totalPages).map((item, index) =>
					item === "ellipsis" ? (
						<PaginationEllipsis key={`ellipsis-${index}`} />
					) : (
						<PaginationItem key={item}>
							<PaginationLink
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
							className="h-10 bg-transparent hover:bg-gray-4"
							href={hrefForPage(currentPage + 1)}
						/>
					</PaginationItem>
				)}
			</PaginationContent>
		</Pagination>
	);
};
