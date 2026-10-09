// Runtime-neutral (no node:fs / Buffer): shared by the CLI, CI and the cms Worker.

/** One file change in a publish bundle. Text is sent as utf8, anything else as base64. */
export interface BundleChange {
  path: string;                       // repo-relative, forward slashes
  op: "put" | "delete";
  encoding?: "utf8" | "base64";       // put only; default utf8
  content?: string;                   // put only
  /** Size in bytes of the decoded content (put only); informational, used for limits. */
  size?: number;
}
export interface Bundle {
  /** Commit the changes were authored against (the local HEAD / origin/main at collection time). */
  base_sha?: string;
  changes: BundleChange[];
}

/** Read-only view of a repo tree at one commit. The CLI backs it with `git show`, the Worker with the GitHub API. */
export interface FileView {
  read(path: string): Promise<string | null>;     // null = does not exist (or is binary)
  exists(path: string): Promise<boolean>;
}

/** In-memory view; used by tests and as the simplest base for fixtures. */
export class MapView implements FileView {
  constructor(private files: Record<string, string>) {}
  async read(p: string) { return p in this.files ? this.files[p] : null; }
  async exists(p: string) { return p in this.files; }
}

/** `base` with a bundle's changes laid on top: the post-publish state a validator should judge. */
export class OverlayView implements FileView {
  private put = new Map<string, BundleChange>();
  private del = new Set<string>();
  constructor(private base: FileView, bundle: Bundle) {
    for (const c of bundle.changes) {
      if (c.op === "delete") { this.del.add(c.path); this.put.delete(c.path); }
      else { this.put.set(c.path, c); this.del.delete(c.path); }
    }
  }
  async read(p: string) {
    if (this.del.has(p)) return null;
    const c = this.put.get(p);
    if (c) return (c.encoding ?? "utf8") === "utf8" ? (c.content ?? "") : null;
    return this.base.read(p);
  }
  async exists(p: string) {
    if (this.del.has(p)) return false;
    if (this.put.has(p)) return true;
    return this.base.exists(p);
  }
  touches(p: string) { return this.put.has(p) || this.del.has(p); }
}

const RE_SPECIAL = /[.+^${}()|[\]\\]/g;
/** `**` = any depth (incl. none), `*` = one path segment, `?` = one non-slash char. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") { out += "(?:.*/)?"; i++; } else out += ".*";
      } else out += "[^/]*";
    } else if (ch === "?") out += "[^/]";
    else out += ch.replace(RE_SPECIAL, "\\$&");
  }
  return new RegExp(`^${out}$`);
}
export function matchesAny(globs: string[], p: string): boolean {
  return globs.some(g => globToRegExp(g).test(p));
}
