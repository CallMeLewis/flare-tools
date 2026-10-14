import type { ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface DisabledHintProps {
  /** Why the control is disabled, or null when it isn't. */
  reason: ReactNode | null;
  children: ReactNode;
}

/**
 * Explains a disabled control on hover. Disabled buttons don't get pointer events, so the
 * tooltip hangs off a wrapper instead.
 */
export function DisabledHint({ reason, children }: DisabledHintProps) {
  if (!reason) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>{children}</TooltipTrigger>
      <TooltipContent side="bottom">{reason}</TooltipContent>
    </Tooltip>
  );
}
