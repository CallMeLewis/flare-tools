import { Fragment, useMemo, useRef, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  BoldIcon,
  CodeIcon,
  EyeOffIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ImageIcon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  MinusIcon,
  QuoteIcon,
  StrikethroughIcon,
  TableIcon,
  UnderlineIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Counter } from "@/components/workshop/counter";
import { api } from "@/lib/api";
import { parseBBCode, type BBNode } from "@/lib/bbcode";
import { cn } from "@/lib/utils";
import { textBytes } from "@/lib/workshop";

interface BBCodeEditorProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Characters allowed, shown as a counter. */
  max: number;
}

/** Works out the text to insert for a selection, and what to select afterwards. */
type Edit = (selected: string, before: string) => { text: string; select?: [number, number] };

interface Action {
  label: string;
  icon: LucideIcon;
  /** Ctrl plus this key, inside the editor. */
  key?: string;
  edit: Edit;
}

/** Wraps the selection in a tag, or inserts the tag around a placeholder and selects it. */
function wrap(tag: string, placeholder: string, value?: string): Edit {
  return (selected) => {
    const open = `[${tag}${value === undefined ? "" : `=${value}`}]`;
    const inner = selected || placeholder;
    return { text: `${open}${inner}[/${tag}]`, select: [open.length, open.length + inner.length] };
  };
}

/** Starts block tags on their own line. */
function lineStart(before: string) {
  return before.length === 0 || before.endsWith("\n") ? "" : "\n";
}

function list(tag: "list" | "olist"): Edit {
  return (selected, before) => {
    const lines = (selected || "Item").split("\n").map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ""));
    const lead = `${lineStart(before)}[${tag}]\n[*]`;
    const text = `${lead}${lines.join("\n[*]")}\n[/${tag}]`;
    return { text, select: selected ? undefined : [lead.length, lead.length + lines[0].length] };
  };
}

const URL_LIKE = /^https?:\/\/\S+$/i;

const ACTIONS: Action[][] = [
  [
    { label: "Heading 1", icon: Heading1Icon, edit: (s, b) => prefixed(lineStart(b), wrap("h1", "Heading")(s, b)) },
    { label: "Heading 2", icon: Heading2Icon, edit: (s, b) => prefixed(lineStart(b), wrap("h2", "Heading")(s, b)) },
    { label: "Heading 3", icon: Heading3Icon, edit: (s, b) => prefixed(lineStart(b), wrap("h3", "Heading")(s, b)) },
  ],
  [
    { label: "Bold", icon: BoldIcon, key: "b", edit: wrap("b", "bold text") },
    { label: "Italic", icon: ItalicIcon, key: "i", edit: wrap("i", "italic text") },
    { label: "Underline", icon: UnderlineIcon, key: "u", edit: wrap("u", "underlined text") },
    { label: "Strikethrough", icon: StrikethroughIcon, edit: wrap("strike", "struck text") },
    { label: "Spoiler", icon: EyeOffIcon, edit: wrap("spoiler", "hidden text") },
  ],
  [
    {
      label: "Link",
      icon: LinkIcon,
      key: "k",
      edit: (selected) => {
        if (URL_LIKE.test(selected)) return { text: `[url=${selected}]${selected}[/url]` };
        const open = "[url=";
        const url = "https://";
        return { text: `${open}${url}]${selected || "link text"}[/url]`, select: [open.length, open.length + url.length] };
      },
    },
    { label: "Image", icon: ImageIcon, edit: wrap("img", "https://") },
  ],
  [
    { label: "Bulleted list", icon: ListIcon, edit: list("list") },
    { label: "Numbered list", icon: ListOrderedIcon, edit: list("olist") },
    { label: "Quote", icon: QuoteIcon, edit: (s, b) => prefixed(lineStart(b), wrap("quote", "quoted text")(s, b)) },
    { label: "Code", icon: CodeIcon, edit: (s, b) => prefixed(lineStart(b), wrap("code", "code")(s, b)) },
    {
      label: "Table",
      icon: TableIcon,
      edit: (_, before) => {
        const lead = `${lineStart(before)}[table]\n[tr]\n[th]`;
        return {
          text: `${lead}Heading[/th]\n[th]Heading[/th]\n[/tr]\n[tr]\n[td]Cell[/td]\n[td]Cell[/td]\n[/tr]\n[/table]\n`,
          select: [lead.length, lead.length + "Heading".length],
        };
      },
    },
    { label: "Divider", icon: MinusIcon, edit: (_, before) => ({ text: `${lineStart(before)}[hr][/hr]\n` }) },
  ],
];

function prefixed(prefix: string, result: ReturnType<Edit>): ReturnType<Edit> {
  return {
    text: prefix + result.text,
    select: result.select && [result.select[0] + prefix.length, result.select[1] + prefix.length],
  };
}

const SHORTCUTS = new Map(ACTIONS.flat().filter((a) => a.key).map((a) => [a.key!, a]));

export function BBCodeEditor({ id, label, value, onChange, disabled, max }: BBCodeEditorProps) {
  const [mode, setMode] = useState<"write" | "preview">("write");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const over = textBytes(value) > max;

  function apply(action: Action) {
    const el = textarea.current;
    if (!el || disabled) return;
    el.focus();
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const { text, select } = action.edit(el.value.slice(start, end), el.value.slice(0, start));
    // insertText keeps the change on the textarea's undo stack, unlike setting the value.
    if (!document.execCommand("insertText", false, text)) {
      onChange(el.value.slice(0, start) + text + el.value.slice(end));
    }
    if (select) el.setSelectionRange(start + select[0], start + select[1]);
  }

  return (
    <Field>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <div className="flex items-center gap-3">
          <Counter value={value} max={max} />
          <Tabs value={mode} onValueChange={(next) => setMode(next as "write" | "preview")}>
            <TabsList className="h-7">
              <TabsTrigger value="write" className="px-2 text-xs">
                Write
              </TabsTrigger>
              <TabsTrigger value="preview" className="px-2 text-xs">
                Preview
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>

      <div
        className={cn(
          "overflow-hidden rounded-lg border border-input dark:bg-input/30",
          mode === "write" && "focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
          over && "border-destructive",
        )}
      >
        {mode === "write" ? (
          <>
            <div role="toolbar" aria-label="Formatting" aria-controls={id} className="flex flex-wrap items-center gap-0.5 border-b p-1">
              {ACTIONS.map((group, index) => (
                <Fragment key={index}>
                  {index > 0 && <span className="mx-1 h-4 w-px bg-border" aria-hidden />}
                  {group.map((action) => (
                    <Tooltip key={action.label}>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={action.label}
                            disabled={disabled}
                            // Keep the textarea's selection when the button is pressed.
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => apply(action)}
                          />
                        }
                      >
                        <action.icon />
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        {action.label}
                        {action.key && <span className="text-background/60">Ctrl {action.key.toUpperCase()}</span>}
                      </TooltipContent>
                    </Tooltip>
                  ))}
                </Fragment>
              ))}
            </div>
            <textarea
              ref={textarea}
              id={id}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => {
                const action = e.ctrlKey && !e.shiftKey && !e.altKey ? SHORTCUTS.get(e.key.toLowerCase()) : undefined;
                if (action) {
                  e.preventDefault();
                  e.stopPropagation();
                  apply(action);
                }
              }}
              disabled={disabled}
              aria-invalid={over || undefined}
              spellCheck
              className="block min-h-[30rem] w-full resize-y bg-transparent px-3 py-2 font-mono text-xs leading-relaxed outline-none placeholder:text-muted-foreground disabled:opacity-50"
              placeholder="Describe the mod. Select text and use the toolbar to format it."
            />
          </>
        ) : (
          <div className="min-h-[30rem] px-4 py-3 text-sm leading-relaxed break-words select-text">
            <BBCodePreview text={value} />
          </div>
        )}
      </div>
      <FieldDescription>
        {mode === "write"
          ? "Steam formats this with BBCode. The preview is close to, but not exactly, how Steam shows it."
          : "Links open in your browser."}
      </FieldDescription>
    </Field>
  );
}

function BBCodePreview({ text }: { text: string }) {
  const nodes = useMemo(() => parseBBCode(text), [text]);
  if (!text.trim()) return <p className="text-muted-foreground">Nothing to preview yet.</p>;
  return <>{render(nodes, false)}</>;
}

function safeUrl(url: string | null) {
  const trimmed = url?.trim() ?? "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

function textOf(nodes: BBNode[]): string {
  return nodes.map((n) => (typeof n === "string" ? n : textOf(n.children))).join("");
}

/** Drops the line breaks around a list item's or cell's contents, which come from how it was typed. */
function trimmed(nodes: BBNode[]): BBNode[] {
  return nodes.map((node, i) => {
    if (typeof node !== "string") return node;
    let text = node;
    if (i === 0) text = text.trimStart();
    if (i === nodes.length - 1) text = text.trimEnd();
    return text;
  });
}

/** Line breaks become `<br>`, except between the parts of lists and tables. */
function render(nodes: BBNode[], structural: boolean): ReactNode[] {
  return nodes.map((node, index) => {
    if (typeof node === "string") {
      if (structural) return node.trim() ? <Fragment key={index}>{node.trim()}</Fragment> : null;
      // A block tag already starts a new line, so drop the line break typed straight after it.
      const previous = nodes[index - 1];
      const afterBlock = typeof previous === "object" && BLOCK.has(previous.tag);
      const text = afterBlock ? node.replace(/^\r?\n/, "") : node;
      return text.split("\n").map((line, i) => (
        <Fragment key={`${index}-${i}`}>
          {i > 0 && <br />}
          {line}
        </Fragment>
      ));
    }
    const children = () => render(node.children, STRUCTURAL.has(node.tag));
    switch (node.tag) {
      case "h1":
        return <h1 key={index} className="mt-3 mb-1 text-xl font-bold first:mt-0">{children()}</h1>;
      case "h2":
        return <h2 key={index} className="mt-3 mb-1 text-lg font-semibold first:mt-0">{children()}</h2>;
      case "h3":
        return <h3 key={index} className="mt-2 mb-1 text-base font-semibold first:mt-0">{children()}</h3>;
      case "b":
        return <strong key={index}>{children()}</strong>;
      case "i":
        return <em key={index}>{children()}</em>;
      case "u":
        return <u key={index}>{children()}</u>;
      case "strike":
        return <s key={index}>{children()}</s>;
      case "spoiler":
        return (
          <span
            key={index}
            tabIndex={0}
            title="Spoiler"
            className="rounded-sm bg-foreground/90 text-transparent transition-colors outline-none hover:bg-transparent hover:text-foreground focus-visible:bg-transparent focus-visible:text-foreground"
          >
            {children()}
          </span>
        );
      case "hr":
        return <hr key={index} className="my-3 border-border" />;
      case "url": {
        const href = safeUrl(node.value ?? textOf(node.children));
        return (
          <a
            key={index}
            href={href ?? undefined}
            onClick={(e) => {
              e.preventDefault();
              if (href) void api.openUrl(href);
            }}
            className="text-info underline underline-offset-2 hover:text-info/80"
          >
            {children()}
          </a>
        );
      }
      case "img": {
        const src = safeUrl(textOf(node.children));
        return src ? (
          <img key={index} src={src} alt="" className="my-1 max-w-full rounded" />
        ) : (
          <span key={index} className="text-muted-foreground">[image]</span>
        );
      }
      case "list":
        return <ul key={index} className="my-1 list-disc pl-6">{children()}</ul>;
      case "olist":
        return <ol key={index} className="my-1 list-decimal pl-6">{children()}</ol>;
      case "*":
        return <li key={index}>{render(trimmed(node.children), false)}</li>;
      case "quote":
        return (
          <blockquote key={index} className="my-2 border-l-2 border-border bg-muted/40 px-3 py-2 text-muted-foreground">
            {node.value && <p className="mb-1 text-xs">Originally posted by {node.value}:</p>}
            {children()}
          </blockquote>
        );
      case "code":
      case "noparse":
        return node.tag === "code" ? (
          <pre key={index} className="my-2 overflow-x-auto rounded bg-muted px-3 py-2 dark:bg-background font-mono text-xs">
            {textOf(node.children).replace(/^\r?\n/, "")}
          </pre>
        ) : (
          <Fragment key={index}>{textOf(node.children)}</Fragment>
        );
      case "table":
        return (
          <table key={index} className="my-2 border-collapse text-xs">
            <tbody>{children()}</tbody>
          </table>
        );
      case "tr":
        return <tr key={index}>{children()}</tr>;
      case "th":
        return <th key={index} className="border border-border px-2 py-1 text-left font-semibold">{render(trimmed(node.children), false)}</th>;
      case "td":
        return <td key={index} className="border border-border px-2 py-1">{render(trimmed(node.children), false)}</td>;
      case "previewyoutube":
        return (
          <span key={index} className="my-1 block rounded border border-dashed px-3 py-6 text-center text-muted-foreground">
            YouTube video {node.value?.split(";")[0]}
          </span>
        );
      default:
        return <Fragment key={index}>{children()}</Fragment>;
    }
  });
}

const BLOCK = new Set(["h1", "h2", "h3", "hr", "list", "olist", "quote", "code", "table", "previewyoutube"]);
/** Tags whose direct text is only the whitespace between their parts. */
const STRUCTURAL = new Set(["list", "olist", "table", "tr"]);
