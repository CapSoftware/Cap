"use client";

import {
  LogoBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@cap/ui";
import {
  faAppleWhole,
  faDesktop,
  faMobileScreen,
  faTablet,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import getUnicodeFlagIcon from "country-flag-icons/unicode";
import Image from "next/image";
import { useRouter } from "next/navigation";

const countryCodeToIcon = (countryCode: string | undefined | null) => {
  if (!countryCode || countryCode.trim() === "") {
    return null;
  }
  return getUnicodeFlagIcon(countryCode.toUpperCase());
};

const formatNumber = (value?: number | null) =>
  value == null ? "—" : value.toLocaleString();
const formatPercentage = (value?: number | null) =>
  value == null ? "—" : `${Math.round(value * 100)}%`;
const skeletonBar = (width = 48) => (
  <div
    className="h-4 rounded bg-gray-4 animate-pulse"
    style={{ width: `${width}px` }}
  />
);

type BrowserType =
  | "google-chrome"
  | "firefox"
  | "safari"
  | "explorer"
  | "opera"
  | "brave"
  | "vivaldi"
  | "yandex"
  | "duckduckgo"
  | "internet-explorer"
  | "samsung-internet"
  | "uc-browser"
  | "qq-browser"
  | "maxthon"
  | "arora"
  | "lunascape";

type OperatingSystemType = "windows" | "ios" | "linux" | "fedora" | "ubuntu";

type DeviceType = "desktop" | "tablet" | "mobile";

export interface CountryRowData {
  countryCode: string;
  name: string;
  views: number;
  comments?: number | null;
  reactions?: number | null;
  percentage: number;
}

export interface CityRowData {
  countryCode: string;
  name: string;
  views: number;
  comments?: number | null;
  reactions?: number | null;
  percentage: number;
}

export interface BrowserRowData {
  browser: BrowserType;
  name: string;
  views: number;
  comments?: number | null;
  reactions?: number | null;
  percentage: number;
}

export interface OSRowData {
  os: OperatingSystemType;
  name: string;
  views: number;
  comments?: number | null;
  reactions?: number | null;
  percentage: number;
}

export interface DeviceRowData {
  device: DeviceType;
  name: string;
  views: number;
  comments?: number | null;
  reactions?: number | null;
  percentage: number;
}

export interface CapRowData {
  name: string;
  views: number;
  comments?: number | null;
  reactions?: number | null;
  percentage: number;
  id?: string;
}

export interface TableCardProps {
  title: string;
  columns: string[];
  tableClassname?: string;
  type: "country" | "city" | "browser" | "os" | "device" | "cap";
  rows:
    | CountryRowData[]
    | CityRowData[]
    | BrowserRowData[]
    | OSRowData[]
    | DeviceRowData[]
    | CapRowData[];
  isLoading?: boolean;
}

const TableCard = ({
  title: _title,
  columns,
  rows,
  type,
  tableClassname,
  isLoading,
}: TableCardProps) => {
  const router = useRouter();
  const hasRows = rows.length > 0;
  const placeholders = Array.from({ length: 4 }, (_, index) => ({
    name: `placeholder-${index}`,
    views: 0,
    comments: null,
    reactions: null,
    percentage: 0,
  })) as TableCardProps["rows"];

  const displayRows = isLoading || !hasRows ? placeholders : rows;
  const showSkeletons = isLoading || !hasRows;

  const handleCapNameClick = (capId: string | undefined) => {
    if (capId && type === "cap") {
      router.push(`/dashboard/analytics?capId=${capId}`);
    }
  };

  return (
    <div className="relative p-5 w-full rounded-xl border bg-gray-2 border-gray-4 min-h-[400px] max-h-[400px] overflow-y-auto">
      {/* <div className="flex flex-1 gap-2 justify-between items-center h-[48px]">
        <p className="text-lg font-medium text-gray-12">{title}</p>
        <Select
          variant="light"
          placeholder="Views"
          icon={<FontAwesomeIcon icon={faFilter} className="text-gray-11" />}
          options={[
            { value: "views", label: "Views" },
            { value: "comments", label: "Comments" },
            { value: "reactions", label: "Reactions" },
          ]}
          value="views"
          onValueChange={() => {}}
          size="sm"
        />
      </div> */}
      <div className="flex flex-1 flex-col gap-4 justify-center">
        <div className="relative w-full">
          <Table className="w-full border-separate table-fixed border-spacing-y-2">
            <TableHeader className="sticky top-0 z-10 bg-gray-2 text-xs uppercase text-gray-11 opacity-70">
              <TableRow>
                {columns.map((column) => (
                  <TableHead className="px-3 text-left" key={column}>
                    {column}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody
              className={clsx(
                "before:content-[''] before:block w-full",
                tableClassname
              )}
            >
              {displayRows.map((row, index) => {
                const capRow = type === "cap" ? (row as CapRowData) : null;
                const uniqueKey = `${row.name ?? `row-${index}`}-${index}`;
                const isCap = type === "cap";
                const isClickable = isCap && capRow?.id && !showSkeletons;
                return (
                  <TableRow className="w-full" key={uniqueKey}>
                    <TableCell className="p-2.5 text-sm rounded-l-lg border-l border-y text-gray-11 bg-gray-3 border-gray-5">
                      <div className="flex gap-2 items-center min-w-0">
                        <span className="flex-shrink-0 fill-[var(--gray-12)]">
                          {showSkeletons ? (
                            <div className="size-4 rounded bg-gray-4 animate-pulse" />
                          ) : (
                            getIconForRow(row, type)
                          )}
                        </span>
                        {isClickable ? (
                          <button
                            type="button"
                            onClick={() => handleCapNameClick(capRow?.id)}
                            className="truncate text-left hover:text-gray-12 transition-colors cursor-pointer"
                            title={row.name}
                          >
                            {row.name}
                          </button>
                        ) : (
                          <span
                            className={clsx(
                              "truncate",
                              isCap && !showSkeletons && "cursor-default"
                            )}
                            title={
                              isCap && !showSkeletons ? row.name : undefined
                            }
                          >
                            {showSkeletons ? (
                              <div className="h-4 w-24 rounded bg-gray-4 animate-pulse" />
                            ) : (
                              row.name
                            )}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="py-2.5 px-3 text-sm text-nowrap text-gray-11 bg-gray-3 border-y border-gray-5 whitespace-nowrap">
                      {showSkeletons
                        ? skeletonBar(48)
                        : formatNumber(row.views)}
                    </TableCell>
                    <TableCell className="p-2.5 px-3 text-sm text-nowrap rounded-r-lg border-r text-gray-11 bg-gray-3 border-y border-gray-5 whitespace-nowrap">
                      {showSkeletons
                        ? skeletonBar(40)
                        : formatPercentage(row.percentage)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
};

const getIconForRow = (
  row:
    | CountryRowData
    | CityRowData
    | BrowserRowData
    | OSRowData
    | DeviceRowData
    | CapRowData,
  type: TableCardProps["type"]
) => {
  switch (type) {
    case "country":
      return countryCodeToIcon((row as CountryRowData).countryCode);
    case "city":
      return countryCodeToIcon((row as CityRowData).countryCode);
    case "browser":
      return <BrowserIcon browser={(row as BrowserRowData).browser} />;
    case "os":
      return <OperatingSystemIcon operatingSystem={(row as OSRowData).os} />;
    case "device": {
      const device = (row as DeviceRowData).device;
      const iconMap = {
        desktop: faDesktop,
        tablet: faTablet,
        mobile: faMobileScreen,
      };
      return (
        <FontAwesomeIcon icon={iconMap[device]} className="text-gray-12" />
      );
    }
    case "cap":
      return <LogoBadge className="size-4" />;
    default:
      return null;
  }
};

type OperatingSystemIconProps = {
  operatingSystem: OperatingSystemType;
};

const OperatingSystemIcon = ({ operatingSystem }: OperatingSystemIconProps) => {
  if (operatingSystem === "ios") {
    return <FontAwesomeIcon className="text-gray-12" icon={faAppleWhole} />;
  }
  return (
    <Image
      src={`/logos/os/${operatingSystem}.svg`}
      alt={operatingSystem}
      width={16}
      height={16}
      className="size-4"
    />
  );
};

type BrowserIconProps = {
  browser: BrowserType;
};

const BrowserIcon = ({ browser }: BrowserIconProps) => (
  <Image
    src={`/logos/browsers/${browser}.svg`}
    alt={browser}
    width={16}
    height={16}
    className="size-4"
  />
);

export default TableCard;
