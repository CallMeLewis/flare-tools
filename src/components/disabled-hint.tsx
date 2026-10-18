import type { ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@flare/ui/ui/tooltip";

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
      <TooltipTrigger asChild><span className="inline-flex">{children}</span></TooltipTrigger>
      <TooltipContent side="bottom">{reason}</TooltipContent>
    </Tooltip>
  );
}
