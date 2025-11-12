"use client";

import {
  cloneElement,
  type HTMLAttributes,
  type SVGProps,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CapIcon,
  ChatIcon,
  ClapIcon,
  ReactionIcon,
} from "@/app/(org)/dashboard/_components/AnimatedIcons";
import { classNames } from "@/utils/helpers";
import type { CapIconHandle } from "../../_components/AnimatedIcons/Cap";
import ChartArea from "./ChartArea";

type boxes = "caps" | "views" | "comments" | "reactions";
type ChartPoint = {
  bucket: string;
  caps: number;
  views: number;
  comments: number;
  reactions: number;
};

const formatCount = (value: number) => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString();
};

interface StatsChartProps {
  counts: Record<boxes, number>;
  data: ChartPoint[];
  defaultSelectedBox?: boxes;
  isLoading?: boolean;
}

export default function StatsBox({
  counts,
  data,
  defaultSelectedBox = "caps",
  isLoading,
}: StatsChartProps) {
  const [selectedBox, setSelectedBox] = useState<boxes>(defaultSelectedBox);

  const capsBoxRef = useRef<CapIconHandle | null>(null);
  const viewsBoxRef = useRef<CapIconHandle | null>(null);
  const chatsBoxRef = useRef<CapIconHandle | null>(null);
  const reactionsBoxRef = useRef<CapIconHandle | null>(null);

  const selectHandler = (box: boxes) => {
    setSelectedBox(box);
  };

  const formattedCounts = useMemo(
    () => ({
      caps: formatCount(counts.caps),
      views: formatCount(counts.views),
      comments: formatCount(counts.comments),
      reactions: formatCount(counts.reactions),
    }),
    [counts]
  );

  return (
    <div className="flex flex-col gap-4 px-8 pt-8 w-full rounded-xl border bg-gray-1 border-gray-3">
      <div className="flex flex-wrap gap-4">
        <StatBox
          onClick={() => selectHandler("caps")}
          isSelected={selectedBox === "caps"}
          title="Caps"
          value={formattedCounts.caps}
          onMouseEnter={() => capsBoxRef.current?.startAnimation()}
          onMouseLeave={() => capsBoxRef.current?.stopAnimation()}
          icon={<CapIcon ref={capsBoxRef} size={20} />}
        />
        <StatBox
          onClick={() => selectHandler("views")}
          isSelected={selectedBox === "views"}
          title="Views"
          value={formattedCounts.views}
          onMouseEnter={() => viewsBoxRef.current?.startAnimation()}
          onMouseLeave={() => viewsBoxRef.current?.stopAnimation()}
          icon={<ClapIcon ref={viewsBoxRef} size={20} />}
        />
        <StatBox
          onClick={() => selectHandler("comments")}
          isSelected={selectedBox === "comments"}
          title="Comments"
          value={formattedCounts.comments}
          onMouseEnter={() => chatsBoxRef.current?.startAnimation()}
          onMouseLeave={() => chatsBoxRef.current?.stopAnimation()}
          icon={<ChatIcon ref={chatsBoxRef} size={20} />}
        />
        <StatBox
          onClick={() => selectHandler("reactions")}
          isSelected={selectedBox === "reactions"}
          title="Reactions"
          value={formattedCounts.reactions}
          onMouseEnter={() => reactionsBoxRef.current?.startAnimation()}
          onMouseLeave={() => reactionsBoxRef.current?.stopAnimation()}
          icon={<ReactionIcon ref={reactionsBoxRef} size={20} />}
        />
      </div>
      <ChartArea
        selectedMetric={selectedBox}
        data={data}
        isLoading={isLoading}
      />
    </div>
  );
}

interface StatBoxProps extends HTMLAttributes<HTMLDivElement> {
  title: string;
  value: string;
  icon: React.ReactElement<SVGProps<SVGSVGElement>>;
  isSelected?: boolean;
}
function StatBox({
  title,
  value,
  icon,
  isSelected = false,
  ...props
}: StatBoxProps) {
  return (
    <div
      {...props}
      className={classNames(
        "flex flex-col flex-1 min-w-[150px] gap-2 px-8 py-6 bg-transparent rounded-xl border transition-all duration-200 cursor-pointer group h-fit hover:bg-gray-3 border-gray-5",
        isSelected && "bg-gray-3 border-gray-8"
      )}
    >
      <div className="flex gap-2 items-center h-fit">
        {cloneElement(icon, {
          className: classNames(
            "group-hover:text-gray-12 transition-colors duration-200",
            isSelected ? "text-gray-12" : "text-gray-10"
          ),
        })}
        <p
          className={classNames(
            "text-base font-medium transition-colors duration-200 group-hover:text-gray-12 text-gray-10",
            isSelected && "text-gray-12"
          )}
        >
          {title}
        </p>
      </div>
      <p className="text-2xl font-medium transition-colors duration-200 text-gray-12">
        {value}
      </p>
    </div>
  );
}
