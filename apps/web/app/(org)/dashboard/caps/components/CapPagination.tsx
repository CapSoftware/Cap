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
			<PaginationContent>
				{currentPage > 1 && (
					<PaginationItem>
						<PaginationPrevious
							asChild
							className="h-10 bg-transparent hover:bg-gray-4"
						>
							<Link href={hrefForPage(currentPage - 1)} scroll={false} />
						</PaginationPrevious>
					</PaginationItem>
				)}
				<PaginationItem>
					<PaginationLink
						asChild
						className="h-10 min-w-10"
						isActive={currentPage === 1}
					>
						<Link href={hrefForPage(1)} scroll={false}>
							1
						</Link>
					</PaginationLink>
				</PaginationItem>
				{currentPage !== 1 && (
					<PaginationItem>
						<PaginationLink
							asChild
							className="h-10 min-w-10"
							isActive={true}
						>
							<Link href={hrefForPage(currentPage)} scroll={false}>
								{currentPage}
							</Link>
						</PaginationLink>
					</PaginationItem>
				)}
				{totalPages > currentPage + 1 && (
					<PaginationItem>
						<PaginationLink
							asChild
							className="h-10 min-w-10 hover:bg-gray-3"
							isActive={false}
						>
							<Link href={hrefForPage(currentPage + 1)} scroll={false}>
								{currentPage + 1}
							</Link>
						</PaginationLink>
					</PaginationItem>
				)}
				{currentPage > 2 && <PaginationEllipsis />}
				<PaginationItem>
					<PaginationNext
						asChild
						className="h-10 bg-transparent hover:bg-gray-4"
					>
						<Link
							href={hrefForPage(
								currentPage === totalPages ? currentPage : currentPage + 1,
							)}
							scroll={false}
						/>
					</PaginationNext>
				</PaginationItem>
			</PaginationContent>
		</Pagination>
	);
};
