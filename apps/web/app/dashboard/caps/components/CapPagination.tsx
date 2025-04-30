import { serverEnv } from "@cap/env";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@cap/ui";

interface CapPaginationProps {
  currentPage: number;
  totalPages: number;
}

export const CapPagination: React.FC<CapPaginationProps> = ({
  currentPage,
  totalPages,
}) => {
  return (
    <Pagination>
      <PaginationContent>
        {currentPage > 1 && (
          <PaginationItem>
            <PaginationPrevious
              href={`/dashboard/caps?page=${currentPage - 1}`}
            />
          </PaginationItem>
        )}
        <PaginationItem>
          <PaginationLink
            className="min-w-[54px]"
            href={`/dashboard/caps?page=1`}
            isActive={currentPage === 1}
          >
            1
          </PaginationLink>
        </PaginationItem>
        {currentPage !== 1 && (
          <PaginationItem>
            <PaginationLink
              href={`/dashboard/caps?page=${currentPage}`}
              isActive={true}
            >
              {currentPage}
            </PaginationLink>
          </PaginationItem>
        )}
        {totalPages > currentPage + 1 && (
          <PaginationItem>
            <PaginationLink
              href={`/dashboard/caps?page=${currentPage + 1}`}
              isActive={false}
            >
              {currentPage + 1}
            </PaginationLink>
          </PaginationItem>
        )}
        {currentPage > 2 && <PaginationEllipsis />}
        <PaginationItem>
          <PaginationNext
            href={`/dashboard/caps?page=${
              currentPage === totalPages ? currentPage : currentPage + 1
            }`}
          />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
};
