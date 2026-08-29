import type { ReactNode } from "react";

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
}

export function Tooltip({ content, children }: TooltipProps) {
  return (
    <span className="ui-tooltip" tabIndex={0}>
      {children}
      <span className="ui-tooltip__bubble" role="tooltip">{content}</span>
    </span>
  );
}
