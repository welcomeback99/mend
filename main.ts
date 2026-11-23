// mend: one patch tool for every AI edit format.
// Applies unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edits
// to a tree of text files, exactly as the kit's SPEC.md describes.
// Node 22, standard library only. Run as: node main.ts [options] [PATCH]

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runTrial } from './runner.ts';

type Brk = '\n' | '\r\n';

interface ParsedFile { lines: string[]; brk: Brk; eol: boolean }

class Fail extends Error {
  code: string; path: string;
  constructor(code: string, path: string) { super(code + ' ' + path); this.code = code; this.path = path; }
}

class ParseErr extends Error {
  line: number;
  constructor(line: number) { super('parse ' + line); this.line = line; }
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => { const m = /^[ \t]*/.exec(s); return m ? m[0] : ''; };
const isBlank = (s: string): boolean => s.trim() === '';
const onlyWs = (s: string): boolean => /^[ \t]*$/.test(s);

// Patch lines: split at \n, one trailing \r removed, no empty piece after a final \n.
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function parseFile(text: string): ParsedFile {
  if (text === '') return { lines: [], brk: '\n', eol: false };
  const i = text.indexOf('\n');
  const brk: Brk = i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
  const eol = text.endsWith(brk);
  const body = eol ? text.slice(0, -brk.length) : text;
  return { lines: body.split(brk), brk, eol };
}

function serializeFile(f: ParsedFile): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.brk) + (f.eol ? f.brk : '');
}

function byteCmp(a: string, b: string): number {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  const n = Math.min(ba.length, bb.length);
  for (let i = 0; i < n; i++) { if (ba[i] !== bb[i]) return ba[i] - bb[i]; }
  return ba.length - bb.length;
}

function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

function fail(code: string, path: string): never { throw new Fail(code, path); }

// ---- line matching (SPEC section 5) ----

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

function occurrences(lines: string[], old: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (!tierEq(lines[i + j], old[j], tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

// First tier at which old occurs at least once (tier 0 only when strict).
function findTier(lines: string[], old: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const pos = occurrences(lines, old, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

interface OldNewLine { text: string; ctx: boolean }

// Build the replacement lines for an occurrence at position `at`.
// Context lines are written as the file's own matched lines; at tier 2 the
// other lines are re-indented from the old block's prefix to the file's.
function buildNew(oldEnt: OldNewLine[], newEnt: OldNewLine[], fileLines: string[], at: number, tier: number): string[] {
  const ctxIdx: number[] = [];
  oldEnt.forEach((e, idx) => { if (e.ctx) ctxIdx.push(idx); });
  let ci = 0;
  const f = oldEnt.length > 0 ? leadWs(fileLines[at]) : '';
  const p = oldEnt.length > 0 ? leadWs(oldEnt[0].text) : '';
  return newEnt.map((e) => {
    if (e.ctx) {
      const fl = fileLines[at + ctxIdx[ci]];
      ci += 1;
      return fl;
    }
    if (tier === 2 && e.text !== '' && !onlyWs(e.text) && e.text.startsWith(p)) {
      return f + e.text.slice(p.length);
    }
    return e.text;
  });
}

// Count overlapping occurrences of needle in hay.
function countOcc(hay: string, needle: string): number {
  let n = 0;
  let i = 0;
  for (;;) {
    const j = hay.indexOf(needle, i);
    if (j < 0) break;
    n += 1;
    i = j + 1;
  }
  return n;
}

// ---- working tree ----
// Original files are read lazily from disk; the working copy holds the
// tree as the edits leave it (null = deleted). File contents are plain
// strings; the line model is derived from them when an edit needs lines.

class Tree {
  private orig = new Map<string, string | null>();
  private work = new Map<string, string | null>();
  touched = new Set<string>();

  // Original content (null when the file does not exist on disk).
  original(path: string): string | null {
    if (!this.orig.has(path)) {
      let text: string | null = null;
      try {
        if (existsSync(path)) text = readFileSync(path, 'utf8');
      } catch { text = null; }
      this.orig.set(path, text);
    }
    this.touched.add(path);
    return this.orig.get(path) ?? null;
  }

  get(path: string): string | null {
    if (this.work.has(path)) return this.work.get(path) ?? null;
    return this.original(path);
  }

  set(path: string, text: string | null): void {
    this.touched.add(path);
    this.work.set(path, text);
  }

  snapshot(): Map<string, string | null> {
    return new Map(this.work);
  }

  restore(snap: Map<string, string | null>): void {
    this.work = new Map(snap);
  }

  // Write every change to disk (skipped under --check).
  flush(): void {
    for (const path of this.touched) {
      const o = this.orig.has(path) ? this.orig.get(path) ?? null : this.original(path);
      const w = this.work.has(path) ? this.work.get(path) ?? null : o;
      if (w === o) continue;
      if (w === null) {
        try { unlinkSync(path); } catch { /* already gone */ }
      } else {
        const dir = dirname(path);
        if (dir !== '' && dir !== '.') mkdirSync(dir, { recursive: true });
        writeFileSync(path, w);
      }
    }
  }
}

// ---- command line (SPEC section 1) ----

interface Options { format: string; check: boolean; strict: boolean; patch: string | null }

function parseArgs(argv: string[]): Options | null {
  let format = 'auto';
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let positional: string[] = [];
  let afterDashDash = false;
  for (const a of argv) {
    if (!afterDashDash && a === '--') { afterDashDash = true; continue; }
    if (!afterDashDash && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (seenCheck) return null;
        seenCheck = true; check = true;
      } else if (a === '--strict') {
        if (seenStrict) return null;
        seenStrict = true; strict = true;
      } else if (a.startsWith('--format=')) {
        if (seenFormat) return null;
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (v !== 'auto' && v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json') return null;
        format = v;
      } else {
        return null;
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return null;
  return { format, check, strict, patch: positional.length === 1 ? positional[0] : null };
}

function readPatch(opts: Options): string | null {
  if (opts.patch === null || opts.patch === '-') {
    return readFileSync(0, 'utf8');
  }
  try {
    return readFileSync(opts.patch, 'utf8');
  } catch {
    return null;
  }
}

// ---- format detection (SPEC section 4) ----

function detectFormat(lines: string[]): string | null {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) { first = i; break; }
  }
  if (first < 0) return null;
  const firstTrim = lines[first].trim();
  if (firstTrim === '*** Begin Patch') return 'v4a';
  const firstChar = firstTrim[0];
  if (firstChar === '[' || firstChar === '{') return 'json';
  for (let i = 0; i < lines.length; i++) {
    if (trimEndWs(lines[i]) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---- edits ----

interface Edit {
  // Every path the edit names, in order (safety is checked on these first).
  paths: string[];
  // Applies the edit to the tree; throws Fail on failure. Returns the
  // move pair when the edit is a move that succeeded.
  apply: (tree: Tree, strict: boolean) => { old: string; nw: string } | void;
}

// ---- unified diffs (SPEC section 6) ----

interface BodyLine { kind: 'ctx' | 'del' | 'add'; text: string; noNl: boolean }
interface Hunk { a: number; body: BodyLine[] }

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function headerPath(rest: string): string | null {
  const upToTab = rest.split('\t')[0];
  const t = upToTab.trim();
  if (t === '/dev/null') return null;
  return stripAB(t);
}

interface USection {
  oldPath: string | null;
  newPath: string | null;
  diffOld: string | null;
  diffNew: string | null;
  isNew: boolean;
  isDel: boolean;
  hunks: Hunk[];
}

function parseUnified(lines: string[]): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let pairSet = false;
  let hunksSeen = false;

  const newSection = (): USection => {
    const s: USection = { oldPath: null, newPath: null, diffOld: null, diffNew: null, isNew: false, isDel: false, hunks: [] };
    sections.push(s);
    cur = s;
    pairSet = false;
    hunksSeen = false;
    return s;
  };

  const parseDiffGit = (line: string, idx: number): { old: string; nw: string } => {
    const parts = line.split(' ');
    if (parts.length !== 4 || parts[0] !== 'diff' || parts[1] !== '--git' ||
        !parts[2].startsWith('a/') || !parts[3].startsWith('b/') ||
        parts[2].length < 3 || parts[3].length < 3) {
      throw new ParseErr(idx + 1);
    }
    return { old: parts[2].slice(2), nw: parts[3].slice(2) };
  };

  const parseHunkHeader = (line: string, idx: number): number => {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (!m) throw new ParseErr(idx + 1);
    return parseInt(m[1], 10);
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const d = parseDiffGit(line, i);
      const s = newSection();
      s.diffOld = d.old;
      s.diffNew = d.nw;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      if (cur !== null && !hunksSeen && !pairSet) {
        cur.oldPath = headerPath(line.slice(4));
        cur.newPath = headerPath(lines[i + 1].slice(4));
        pairSet = true;
        i += 2;
        continue;
      }
      const s = newSection();
      s.oldPath = headerPath(line.slice(4));
      s.newPath = headerPath(lines[i + 1].slice(4));
      pairSet = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new ParseErr(i + 1);
      const a = parseHunkHeader(line, i);
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j];
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && j + 1 < lines.length && lines[j + 1].startsWith('+++ ')) break;
        if (bl === '') { body.push({ kind: 'ctx', text: '', noNl: false }); j += 1; continue; }
        if (bl.startsWith(' ')) { body.push({ kind: 'ctx', text: bl.slice(1), noNl: false }); j += 1; continue; }
        if (bl.startsWith('-')) { body.push({ kind: 'del', text: bl.slice(1), noNl: false }); j += 1; continue; }
        if (bl.startsWith('+')) { body.push({ kind: 'add', text: bl.slice(1), noNl: false }); j += 1; continue; }
        if (bl.startsWith('\\')) {
          if (body.length > 0) body[body.length - 1].noNl = true;
          j += 1; continue;
        }
        break;
      }
      // Empty lines at the end of a body are not part of it.
      while (body.length > 0) {
        const last = body[body.length - 1];
        if (last.kind === 'ctx' && last.text === '') {
          body.pop();
          if (last.noNl && body.length > 0) body[body.length - 1].noNl = true;
        } else break;
      }
      cur.hunks.push({ a, body });
      hunksSeen = true;
      i = j;
      continue;
    }
    if (cur !== null && !hunksSeen) {
      // Section header lines.
      if (line.startsWith('--- ')) {
        throw new ParseErr(i + 2);
      }
      if (line.startsWith('rename from ')) {
        if (cur.oldPath === null) cur.oldPath = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        if (cur.newPath === null) cur.newPath = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        cur.isNew = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.isDel = true;
      }
      // index, old/new mode, similarity/dissimilarity index, Index: and
      // every other header line are ignored.
      i += 1;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new ParseErr(1);
  return sections.map((s) => buildUnifiedEdit(s));
}

// Apply one unified hunk to a parsed file; returns the new parsed file.
function applyOneHunk(f: ParsedFile, h: Hunk, path: string, strict: boolean, d: number): ParsedFile {
  const oEnt: OldNewLine[] = h.body
    .filter((e) => e.kind === 'ctx' || e.kind === 'del')
    .map((e) => ({ text: e.text, ctx: e.kind === 'ctx' }));
  const nEnt: OldNewLine[] = h.body
    .filter((e) => e.kind === 'ctx' || e.kind === 'add')
    .map((e) => ({ text: e.text, ctx: e.kind === 'ctx' }));
  const lastCtxAdd = [...h.body].reverse().find((e) => e.kind === 'ctx' || e.kind === 'add');
  let lines = f.lines;
  let eol = f.eol;
  if (oEnt.length === 0) {
    const pos = Math.min(h.a + d, lines.length);
    const atEnd = pos >= lines.length;
    const made = buildNew([], nEnt, lines, pos, 0);
    lines = [...lines.slice(0, pos), ...made, ...lines.slice(pos)];
    if (atEnd) eol = lastCtxAdd ? !lastCtxAdd.noNl : true;
    return { lines, brk: f.brk, eol };
  }
  const found = findTier(lines, oEnt.map((e) => e.text), strict);
  if (!found) fail('no-match', path);
  const target = h.a - 1 + d;
  let at = found.pos[0];
  let best = Math.abs(at - target);
  for (const p of found.pos) {
    const dist = Math.abs(p - target);
    if (dist < best) { at = p; best = dist; }
  }
  const made = buildNew(oEnt, nEnt, lines, at, found.tier);
  const runsToEnd = at + oEnt.length === lines.length;
  lines = [...lines.slice(0, at), ...made, ...lines.slice(at + oEnt.length)];
  if (runsToEnd) eol = lastCtxAdd ? !lastCtxAdd.noNl : true;
  return { lines, brk: f.brk, eol };
}

function buildUnifiedEdit(s: USection): Edit {
  const oldPath = s.oldPath !== null ? s.oldPath : s.diffOld;
  const newPath = s.newPath !== null ? s.newPath : s.diffNew;
  const isCreate = s.oldPath === null || s.isNew;
  const isDelete = s.newPath === null || s.isDel;
  const paths: string[] = [];
  if (oldPath !== null) paths.push(oldPath);
  if (newPath !== null && newPath !== oldPath) paths.push(newPath);
  return {
    paths,
    apply: (tree: Tree, strict: boolean) => {
      if (isCreate) {
        const np = newPath ?? '';
        const cur = tree.get(np);
        if (cur !== null) fail('exists', np);
        const added: string[] = [];
        let lastAddNoNl = false;
        let sawAdd = false;
        for (const h of s.hunks) {
          for (const e of h.body) {
            if (e.kind === 'add') { added.push(e.text); lastAddNoNl = e.noNl; sawAdd = true; }
          }
        }
        const eol = sawAdd ? !lastAddNoNl : false;
        tree.set(np, serializeFile({ lines: added, brk: '\n', eol }));
        return;
      }
      if (isDelete) {
        const op = oldPath ?? '';
        const cur = tree.get(op);
        if (cur === null) fail('missing', op);
        tree.set(op, null);
        return;
      }
      const op = oldPath ?? '';
      const np = newPath ?? '';
      const isMove = oldPath !== null && newPath !== null && oldPath !== newPath;
      const cur = tree.get(op);
      if (cur === null) fail('missing', op);
      if (isMove) {
        const atNew = tree.get(np);
        if (atNew !== null) fail('exists', np);
      }
      let f = parseFile(cur);
      let d = 0;
      for (const h of s.hunks) {
        const nf = applyOneHunk(f, h, op, strict, d);
        d += h.body.filter((e) => e.kind === 'ctx' || e.kind === 'add').length
          - h.body.filter((e) => e.kind === 'ctx' || e.kind === 'del').length;
        f = nf;
      }
      const text = serializeFile(f);
      if (isMove) {
        tree.set(op, null);
        tree.set(np, text);
        return { old: op, nw: np };
      }
      tree.set(op, text);
      return;
    },
  };
}

// ---- SEARCH/REPLACE blocks (SPEC section 7) ----

function parseSR(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (trimEndWs(lines[i]) !== '<<<<<<< SEARCH') { i += 1; continue; }
    const s = i;
    // Path: nearest line before SEARCH, after the previous block's REPLACE,
    // that is not blank and does not start with three backticks.
    let path: string | null = null;
    for (let k = s - 1; k > prevReplace; k--) {
      const t = lines[k].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new ParseErr(s + 1);
    }
    // Find ======= then >>>>>>> REPLACE after SEARCH.
    let eq = -1;
    let rep = -1;
    for (let k = s + 1; k < lines.length; k++) {
      const t = trimEndWs(lines[k]);
      if (t === '=======') { eq = k; break; }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new ParseErr(s + 1);
    for (let k = eq + 1; k < lines.length; k++) {
      if (trimEndWs(lines[k]) === '>>>>>>> REPLACE') { rep = k; break; }
    }
    if (rep < 0) throw new ParseErr(s + 1);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push({
      paths: [p],
      apply: (tree: Tree, strict: boolean) => {
        if (oldLines.length === 0) {
          const cur = tree.get(p);
          if (cur !== null) fail('exists', p);
          tree.set(p, serializeFile({ lines: [...newLines], brk: '\n', eol: true }));
          return;
        }
        const cur = tree.get(p);
        if (cur === null) fail('missing', p);
        const f = parseFile(cur);
        const found = findTier(f.lines, oldLines, strict);
        if (!found) fail('no-match', p);
        if (found.pos.length > 1) fail('ambiguous', p);
        const at = found.pos[0];
        const oEnt: OldNewLine[] = oldLines.map((t) => ({ text: t, ctx: false }));
        const nEnt: OldNewLine[] = newLines.map((t) => ({ text: t, ctx: false }));
        const made = buildNew(oEnt, nEnt, f.lines, at, found.tier);
        const nl = [...f.lines.slice(0, at), ...made, ...f.lines.slice(at + oldLines.length)];
        tree.set(p, serializeFile({ lines: nl, brk: f.brk, eol: f.eol }));
        return;
      },
    });
    prevPath = p;
    prevReplace = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

// ---- V4A patches (SPEC section 8) ----

interface VChunk { anchor: string | null; eof: boolean; body: BodyLine[] }
interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[]; // Add File lines
  chunks: VChunk[];
  lineNo: number; // 1-based line of the section header (for parse errors)
}

const SECTION_START = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function parseV4A(lines: string[]): Edit[] {
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) { if (first < 0) first = i; last = i; }
  }
  if (first < 0) throw new ParseErr(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseErr(first + 1);
  if (lines[last].trim() !== '*** End Patch') throw new ParseErr(lines.length + 1);

  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (isBlank(line)) { i += 1; continue; }
    if (line.startsWith('*** Add File: ')) {
      const sec: VSection = { kind: 'add', path: line.slice('*** Add File: '.length).trim(), moveTo: null, lines: [], chunks: [], lineNo: i + 1 };
      i += 1;
      while (i < last) {
        const l = lines[i];
        if (SECTION_START(l) || l.trim() === '*** End Patch') break;
        if (l.startsWith('+')) { sec.lines.push(l.slice(1)); i += 1; continue; }
        if (l === '') { sec.lines.push(''); i += 1; continue; }
        if (onlyWs(l)) {
          // A blank line at the end of a section is not part of it.
          let k = i + 1;
          let trailing = true;
          while (k < last) {
            const n = lines[k];
            if (SECTION_START(n) || n.trim() === '*** End Patch') break;
            if (!isBlank(n)) { trailing = false; break; }
            k += 1;
          }
          if (trailing) break;
        }
        throw new ParseErr(i + 1);
      }
      while (sec.lines.length > 0 && sec.lines[sec.lines.length - 1] === '') sec.lines.pop();
      sections.push(sec);
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const sec: VSection = { kind: 'delete', path: line.slice('*** Delete File: '.length).trim(), moveTo: null, lines: [], chunks: [], lineNo: i + 1 };
      i += 1;
      while (i < last) {
        const l = lines[i];
        if (SECTION_START(l) || l.trim() === '*** End Patch') break;
        if (isBlank(l)) { i += 1; continue; }
        throw new ParseErr(i + 1);
      }
      sections.push(sec);
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const sec: VSection = { kind: 'update', path: line.slice('*** Update File: '.length).trim(), moveTo: null, lines: [], chunks: [], lineNo: i + 1 };
      i += 1;
      if (i < last && lines[i].startsWith('*** Move to: ')) {
        sec.moveTo = lines[i].slice('*** Move to: '.length).trim();
        i += 1;
      }
      let chunk: VChunk | null = null;
      const closeChunk = (eof: boolean): void => {
        if (chunk !== null) {
          chunk.eof = eof;
          sec.chunks.push(chunk);
          chunk = null;
        }
      };
      while (i < last) {
        const l = lines[i];
        if (SECTION_START(l) || l.trim() === '*** End Patch') break;
        if (l.startsWith('@@')) {
          closeChunk(false);
          chunk = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), eof: false, body: [] };
          i += 1;
          continue;
        }
        if (l === '*** End of File') {
          if (chunk === null) throw new ParseErr(i + 1);
          closeChunk(true);
          i += 1;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (chunk === null) chunk = { anchor: null, eof: false, body: [] };
          const kind = l === '' || l.startsWith(' ') ? 'ctx' : l.startsWith('-') ? 'del' : 'add';
          chunk.body.push({ kind, text: l === '' ? '' : l.slice(1), noNl: false });
          i += 1;
          continue;
        }
        throw new ParseErr(i + 1);
      }
      // Blank lines at the end of a section are not part of it.
      if (chunk !== null) {
        while (chunk.body.length > 0) {
          const b = chunk.body[chunk.body.length - 1];
          if (b.kind === 'ctx' && onlyWs(b.text)) chunk.body.pop();
          else break;
        }
        closeChunk(false);
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new ParseErr(sec.lineNo);
      sections.push(sec);
      continue;
    }
    throw new ParseErr(i + 1);
  }
  if (sections.length === 0) throw new ParseErr(1);
  return sections.map((s) => buildV4AEdit(s));
}

// Apply one V4A chunk to a parsed file, with the cursor. Returns the new
// file and the cursor just after the lines written.
function applyVChunk(f: ParsedFile, c: VChunk, cursor: number, strict: boolean, path: string): { f: ParsedFile; cursor: number } {
  const oEnt: OldNewLine[] = c.body
    .filter((e) => e.kind === 'ctx' || e.kind === 'del')
    .map((e) => ({ text: e.text, ctx: e.kind === 'ctx' }));
  const nEnt: OldNewLine[] = c.body
    .filter((e) => e.kind === 'ctx' || e.kind === 'add')
    .map((e) => ({ text: e.text, ctx: e.kind === 'ctx' }));
  let lines = f.lines;
  if (oEnt.length === 0) {
    const pos = c.eof ? lines.length : cursor;
    const made = buildNew([], nEnt, lines, pos, 0);
    lines = [...lines.slice(0, pos), ...made, ...lines.slice(pos)];
    return { f: { lines, brk: f.brk, eol: f.eol }, cursor: pos + made.length };
  }
  const oldTexts = oEnt.map((e) => e.text);
  let tier = -1;
  let at = -1;
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const pos = occurrences(lines, oldTexts, t).filter((p) => p >= cursor);
    if (pos.length === 0) continue;
    if (c.eof) {
      const end = pos.filter((p) => p + oldTexts.length === lines.length);
      if (end.length === 0) continue;
      tier = t; at = end[0];
      break;
    }
    tier = t; at = pos[0];
    break;
  }
  if (at < 0) fail('no-match', path);
  const made = buildNew(oEnt, nEnt, lines, at, tier);
  lines = [...lines.slice(0, at), ...made, ...lines.slice(at + oldTexts.length)];
  return { f: { lines, brk: f.brk, eol: f.eol }, cursor: at + made.length };
}

function buildV4AEdit(s: VSection): Edit {
  const paths: string[] = [s.path];
  if (s.moveTo !== null && s.moveTo !== s.path) paths.push(s.moveTo);
  return {
    paths,
    apply: (tree: Tree, strict: boolean) => {
      if (s.kind === 'add') {
        const cur = tree.get(s.path);
        if (cur !== null) fail('exists', s.path);
        tree.set(s.path, serializeFile({ lines: [...s.lines], brk: '\n', eol: s.lines.length > 0 }));
        return;
      }
      if (s.kind === 'delete') {
        const cur = tree.get(s.path);
        if (cur === null) fail('missing', s.path);
        tree.set(s.path, null);
        return;
      }
      const cur = tree.get(s.path);
      if (cur === null) fail('missing', s.path);
      const isMove = s.moveTo !== null && s.moveTo !== s.path;
      if (isMove) {
        const atNew = tree.get(s.moveTo as string);
        if (atNew !== null) fail('exists', s.moveTo as string);
      }
      let f = parseFile(cur);
      let cursor = 0;
      for (const c of s.chunks) {
        if (c.anchor !== null) {
          let found = -1;
          const max = strict ? 0 : 2;
          for (let t = 0; t <= max && found < 0; t++) {
            for (let k = cursor; k < f.lines.length; k++) {
              if (tierEq(f.lines[k], c.anchor, t)) { found = k; break; }
            }
          }
          if (found < 0) fail('no-match', s.path);
          cursor = found + 1;
        }
        const r = applyVChunk(f, c, cursor, strict, s.path);
        f = r.f;
        cursor = r.cursor;
      }
      const text = serializeFile(f);
      if (isMove) {
        tree.set(s.path, null);
        tree.set(s.moveTo as string, text);
        return { old: s.path, nw: s.moveTo as string };
      }
      tree.set(s.path, text);
      return;
    },
  };
}

// ---- JSON edits (SPEC section 9) ----

type JsonEdit =
  | { cmd: 'create'; path: string; fileText: string }
  | { cmd: 'str_replace'; path: string; oldStr: string; newStr: string }
  | { cmd: 'insert'; path: string; insertLine: number; newStr: string };

function validJsonEdit(obj: unknown): JsonEdit | null {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  if (typeof o.command !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { cmd: 'create', path: o.path, fileText: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    return { cmd: 'str_replace', path: o.path, oldStr: o.old_str, newStr: typeof o.new_str === 'string' ? o.new_str : '' };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { cmd: 'insert', path: o.path, insertLine: o.insert_line, newStr: o.new_str };
  }
  return null;
}

function parseJSON(patchText: string, lines: string[]): Edit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) { first = i; break; }
  }
  if (first < 0) throw new ParseErr(1);
  const edits: JsonEdit[] = [];
  if (lines[first].trim().startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(patchText);
    } catch {
      throw new ParseErr(first + 1);
    }
    if (!Array.isArray(parsed)) throw new ParseErr(first + 1);
    for (const item of parsed) {
      const e = validJsonEdit(item);
      if (e === null) throw new ParseErr(first + 1);
      edits.push(e);
    }
  } else {
    for (let i = 0; i < lines.length; i++) {
      if (isBlank(lines[i])) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[i]);
      } catch {
        throw new ParseErr(i + 1);
      }
      const e = validJsonEdit(parsed);
      if (e === null) throw new ParseErr(i + 1);
      edits.push(e);
    }
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits.map((e) => buildJsonEdit(e));
}

function buildJsonEdit(e: JsonEdit): Edit {
  return {
    paths: [e.path],
    apply: (tree: Tree, _strict: boolean) => {
      if (e.cmd === 'create') {
        const cur = tree.get(e.path);
        if (cur !== null) fail('exists', e.path);
        tree.set(e.path, e.fileText);
        return;
      }
      if (e.cmd === 'str_replace') {
        const cur = tree.get(e.path);
        if (cur === null) fail('missing', e.path);
        const f = parseFile(cur);
        let text = cur;
        let oldS = e.oldStr;
        let newS = e.newStr;
        if (f.brk === '\r\n') {
          text = cur.split('\r\n').join('\n');
          oldS = oldS.split('\r\n').join('\n');
          newS = newS.split('\r\n').join('\n');
        }
        const n = countOcc(text, oldS);
        if (n === 0) fail('no-match', e.path);
        if (n > 1) fail('ambiguous', e.path);
        const j = text.indexOf(oldS);
        const done = text.slice(0, j) + newS + text.slice(j + oldS.length);
        const out = f.brk === '\r\n' ? done.split('\n').join('\r\n') : done;
        tree.set(e.path, out);
        return;
      }
      const cur = tree.get(e.path);
      if (cur === null) fail('missing', e.path);
      const f = parseFile(cur);
      if (e.insertLine < 0 || e.insertLine > f.lines.length) fail('no-match', e.path);
      const ins = patchLines(e.newStr);
      const nl = [...f.lines.slice(0, e.insertLine), ...ins, ...f.lines.slice(e.insertLine)];
      tree.set(e.path, serializeFile({ lines: nl, brk: f.brk, eol: f.eol }));
      return;
    },
  };
}

// ---- order, atomicity and output (SPEC sections 2 and 10) ----

function runEdits(tree: Tree, edits: Edit[], strict: boolean): { failures: Fail[]; moves: { old: string; nw: string }[] } {
  const failures: Fail[] = [];
  const moves: { old: string; nw: string }[] = [];
  for (const e of edits) {
    // Every path the edit names is checked for safety before anything else.
    let unsafe: string | null = null;
    for (const p of e.paths) {
      if (!isSafePath(p)) { unsafe = p; break; }
    }
    if (unsafe !== null) {
      failures.push(new Fail('unsafe', unsafe));
      continue;
    }
    const snap = tree.snapshot();
    try {
      const mv = e.apply(tree, strict);
      if (mv) moves.push(mv);
    } catch (err) {
      tree.restore(snap);
      if (err instanceof Fail) failures.push(err);
      else throw err;
    }
  }
  return { failures, moves };
}

function changeLines(tree: Tree, moves: { old: string; nw: string }[]): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const m of moves) {
    const o = tree.original(m.old);
    const nOrig = tree.original(m.nw);
    const oNow = tree.get(m.old);
    const nNow = tree.get(m.nw);
    if (o !== null && oNow === null && nOrig === null && nNow !== null) {
      movedOld.add(m.old);
      movedNew.add(m.nw);
      out.push({ key: m.nw, text: `R ${m.old} -> ${m.nw}` });
    }
  }
  for (const path of tree.touched) {
    const o = tree.original(path);
    const w = tree.get(path);
    if (o === w) continue;
    if (movedOld.has(path) || movedNew.has(path)) continue;
    if (o === null && w !== null) out.push({ key: path, text: `A ${path}` });
    else if (o !== null && w === null) out.push({ key: path, text: `D ${path}` });
    else out.push({ key: path, text: `M ${path}` });
  }
  out.sort((a, b) => byteCmp(a.key, b.key));
  return out;
}

function runCli(argv: string[]): number {
  const opts = parseArgs(argv);
  if (opts === null) {
    process.stdout.write('error: usage\n');
    return 2;
  }
  const patchText = readPatch(opts);
  if (patchText === null) {
    process.stdout.write('error: no-patch\n');
    return 2;
  }
  const lines = patchLines(patchText);
  const format = opts.format === 'auto' ? detectFormat(lines) : opts.format;
  if (format === null) {
    process.stdout.write('error: format\n');
    return 2;
  }
  let edits: Edit[];
  try {
    if (format === 'unified') edits = parseUnified(lines);
    else if (format === 'search-replace') edits = parseSR(lines);
    else if (format === 'v4a') edits = parseV4A(lines);
    else edits = parseJSON(patchText, lines);
  } catch (err) {
    if (err instanceof ParseErr) {
      process.stdout.write(`error: parse ${err.line}\n`);
      return 2;
    }
    throw err;
  }
  const tree = new Tree();
  const { failures, moves } = runEdits(tree, edits, opts.strict);
  if (failures.length > 0) {
    const out: string[] = [];
    for (const f of failures) out.push(`error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${edits.length} edits`);
    process.stdout.write(out.join('\n') + '\n');
    return 1;
  }
  const changes = changeLines(tree, moves);
  if (!opts.check) tree.flush();
  const out: string[] = changes.map((c) => c.text);
  out.push(changes.length === 1 ? 'ok: 1 file' : `ok: ${changes.length} files`);
  process.stdout.write(out.join('\n') + '\n');
  return 0;
}

if (process.env.MAKEFUN_ENV_URL) {
  await runTrial(process.env.MAKEFUN_ENV_URL);
} else {
  process.exitCode = runCli(process.argv.slice(2));
}
