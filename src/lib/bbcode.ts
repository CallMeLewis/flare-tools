/** A parsed piece of Steam BBCode: plain text, or a tag with its children. */
export type BBNode = string | BBElement;

export interface BBElement {
  tag: string;
  /** The part after `=`, as in `[url=https://…]`. */
  value: string | null;
  children: BBNode[];
}

/** The tags Steam formats in Workshop descriptions. Anything else is shown as typed. */
const TAGS = new Set([
  "h1",
  "h2",
  "h3",
  "b",
  "i",
  "u",
  "strike",
  "spoiler",
  "noparse",
  "hr",
  "url",
  "img",
  "list",
  "olist",
  "*",
  "quote",
  "code",
  "table",
  "tr",
  "th",
  "td",
  "previewyoutube",
]);
/** Tags whose contents are shown exactly as typed. */
const RAW = new Set(["noparse", "code"]);
const VOID = new Set(["hr"]);

const TAG = /\[(\/?)([a-z0-9]+|\*)(?:=([^\]]*))?\]/gi;

export function parseBBCode(text: string): BBNode[] {
  const root: BBElement = { tag: "", value: null, children: [] };
  const stack: BBElement[] = [root];
  const top = () => stack[stack.length - 1];
  const addText = (value: string) => {
    if (!value) return;
    const children = top().children;
    const last = children[children.length - 1];
    if (typeof last === "string") children[children.length - 1] = last + value;
    else children.push(value);
  };

  let index = 0;
  TAG.lastIndex = 0;
  for (let match = TAG.exec(text); match; match = TAG.exec(text)) {
    const [whole, closing, rawName, value] = match;
    const name = rawName.toLowerCase();
    addText(text.slice(index, match.index));
    index = match.index + whole.length;

    if (!TAGS.has(name)) {
      addText(whole);
      continue;
    }

    if (closing) {
      if (VOID.has(name)) continue;
      // A closing list tag also ends its last item.
      let at = stack.length - 1;
      while (at > 0 && stack[at].tag !== name) at--;
      if (at === 0) addText(whole);
      else stack.length = at;
      continue;
    }

    const element: BBElement = { tag: name, value: value ?? null, children: [] };
    if (RAW.has(name)) {
      const end = text.toLowerCase().indexOf(`[/${name}]`, index);
      const body = end === -1 ? text.slice(index) : text.slice(index, end);
      element.children.push(body);
      top().children.push(element);
      index = end === -1 ? text.length : end + name.length + 3;
      TAG.lastIndex = index;
      continue;
    }
    if (name === "*" && top().tag === "*") stack.pop();
    top().children.push(element);
    if (!VOID.has(name)) stack.push(element);
  }
  addText(text.slice(index));
  return root.children;
}
