import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
// @ts-ignore no types
import { gfm } from "turndown-plugin-gfm";

const STRIP = "script,style,noscript,template,svg,iframe,video,audio,canvas,button,form,input,select,textarea,nav,[aria-hidden='true'],[data-toggle-mode],.lang-switcher,.mode-toggle";

function makeTurndown(): TurndownService {
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "*" });
  td.use(gfm);
  td.addRule("dropEmptyLinks", { filter: (n) => n.nodeName === "A" && !(n.textContent ?? "").trim(), replacement: () => "" });
  return td;
}

export interface MdResult { markdown: string; title: string; method: "readability" | "body"; chars: number; }

export function htmlToMarkdown(html: string, pageUrl: string): MdResult {
  html = html.replace(/<!--\s*dd:chrome:top\s*-->[\s\S]*?<!--\s*\/dd:chrome:top\s*-->/g, "")
             .replace(/<!--\s*dd:chrome:end\s*-->[\s\S]*?<!--\s*\/dd:chrome:end\s*-->/g, "");
  const dom = new JSDOM(html, { url: pageUrl });
  const doc = dom.window.document;
  const title = (doc.querySelector("title")?.textContent ?? doc.querySelector("h1")?.textContent ?? "").trim();
  doc.querySelectorAll(STRIP).forEach(n => n.remove());
  for (const a of doc.querySelectorAll("a[href]")) { try { a.setAttribute("href", new URL(a.getAttribute("href")!, pageUrl).href); } catch {} }
  for (const img of doc.querySelectorAll("img[src]")) { try { img.setAttribute("src", new URL(img.getAttribute("src")!, pageUrl).href); } catch {} }
  const bodyText = (doc.body?.textContent ?? "").replace(/\s+/g, " ").trim();
  const td = makeTurndown();
  let method: MdResult["method"] = "body"; let contentHtml = doc.body?.innerHTML ?? "";
  try {
    const clone = doc.cloneNode(true) as Document;
    const art = new Readability(clone, { charThreshold: 200 }).parse();
    if (art?.content) {
      const artText = (art.textContent ?? "").replace(/\s+/g, " ").trim();
      if (artText.length >= 0.5 * bodyText.length && artText.length > 400) { contentHtml = art.content; method = "readability"; }
    }
  } catch {}
  let md = td.turndown(contentHtml);
  md = md.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+$/gm, "").trim();
  return { markdown: md, title, method, chars: md.length };
}
