import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const HeaderSlot = createContext<HTMLElement | null>(null);

interface ToolPageProps {
  /** A strip under the header, for something that affects the whole page. */
  notice?: ReactNode;
  /** The list card, below the header on the left. */
  list: ReactNode;
  children: ReactNode;
}

/**
 * A tool's page: a header across the full width, then its list card beside whatever is open. The header sits above
 * the list too, so the app's sidebar and the list don't stand side by side as two sidebars.
 */
export function ToolPage({ notice, list, children }: ToolPageProps) {
  const [header, setHeader] = useState<HTMLElement | null>(null);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header ref={setHeader} className="flex h-16 shrink-0 items-center gap-4 border-b px-4" />
      {notice}
      <div className="flex min-h-0 flex-1">
        {list}
        <main className="flex min-w-0 flex-1 flex-col">
          <HeaderSlot.Provider value={header}>{children}</HeaderSlot.Provider>
        </main>
      </div>
    </div>
  );
}

/**
 * What goes in the page's header, rendered from whatever is open below it, which holds the state the header shows.
 * The open mod or item is remade when the selection changes, and this way the list beside it isn't.
 */
export function ToolPageHeader({ children }: { children: ReactNode }) {
  const slot = useContext(HeaderSlot);
  return slot ? createPortal(children, slot) : null;
}

/** The header's title when nothing is open. */
export function ToolPageTitle({ title, description }: { title: string; description: string }) {
  return (
    <ToolPageHeader>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-base font-semibold">{title}</h1>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{description}</p>
      </div>
    </ToolPageHeader>
  );
}
