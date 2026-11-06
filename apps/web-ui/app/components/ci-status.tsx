import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type CIStatusValue = "passing" | "pending" | "failing";

const statusDetails = {
  passing: { label: "Passing", className: "bg-success" },
  pending: { label: "Pending", className: "bg-attention" },
  failing: { label: "Failing", className: "bg-destructive" },
} satisfies Record<CIStatusValue, { label: string; className: string }>;

export function CIStatus({ status, size = "size-2" }: { status: CIStatusValue; size?: string }) {
  const details = statusDetails[status];

  return (
    <Tooltip>
      <TooltipTrigger
        render={<span />}
        aria-label={`CI ${details.label}`}
        className="inline-flex items-center"
      >
        <span aria-hidden="true" className={`${size} rounded-full ${details.className}`} />
        <span className="sr-only">{details.label}</span>
      </TooltipTrigger>
      <TooltipContent>CI {details.label}</TooltipContent>
    </Tooltip>
  );
}
