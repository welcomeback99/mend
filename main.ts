import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

class ParseErr extends Error {
  line: number;
  constructor(line: number) {
    super('parse ' + line);
    this.line = line;
  }
}

function trimEndST(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function trimST(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function trimSpaces(s: string): string {
  return s.replace(/^ +/, '').replace(/ +$/, '');
}
function trailingTrim(s: string): string {
  return s.replace(/\s+$/, '');
}
function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}
function isBlank(s: string): boolean {
  return /^\s*$/.test(s);
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
function splitPatchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}
interface FileDoc {
  text: string;
  brk: string;
  lines: string[];
  eol: boolean;
}
function parseFile(text: string): FileDoc {
  if (text === '') return { text, brk: '\n', lines: [], eol: false };
  const firstLf = text.indexOf('\n');
  const brk = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  const eol = text.endsWith(brk);
  const body = eol ? text.slice(0, -brk.length) : text;
  return { text, brk, lines: body.split(brk), eol };
}
function serializeFile(lines: string[], brk: string, eol: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(brk) + (eol ? brk : '');
}
function byteCmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// ---------- matching (section 5) ----------
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndST(a) === trimEndST(b);
  return trimST(a) === trimST(b);
}
function occurrences(O: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(O[j], lines[i + j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}
function findTier(O: string[], lines: string[], strict: boolean, from: number): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(O, lines, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}
interface NSpec {
  text: string;
  ctx: number;
}
function buildNew(nspec: NSpec[], matched: string[], tier: number, O: string[]): string[] {
  const out: string[] = [];
  const F = matched.length > 0 ? leadWs(matched[0]) : '';
  const P = O.length > 0 ? leadWs(O[0]) : '';
  for (const s of nspec) {
    if (s.ctx >= 0) {
      out.push(matched[s.ctx]);
      continue;
    }
    let t = s.text;
    if (tier === 2 && t !== '' && !/^[ \t]*$/.test(t) && t.startsWith(P)) t = F + t.slice(P.length);
    out.push(t);
  }
  return out;
}

// ---------- CLI (section 1) and detection (section 4) ----------
interface ParsedArgs {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
  err: string | null;
}
function parseArgs(argv: string[]): ParsedArgs {
  let format = 'auto';
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let endOpts = false;
  const positionals: string[] = [];
  for (const a of argv) {
    if (!endOpts && a === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (seenFormat) return { format, check, strict, patch: null, err: 'usage' };
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (v !== 'auto' && v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json') {
          return { format, check, strict, patch: null, err: 'usage' };
        }
        format = v;
      } else if (a === '--check') {
        if (seenCheck) return { format, check, strict, patch: null, err: 'usage' };
        seenCheck = true;
        check = true;
      } else if (a === '--strict') {
        if (seenStrict) return { format, check, strict, patch: null, err: 'usage' };
        seenStrict = true;
        strict = true;
      } else {
        return { format, check, strict, patch: null, err: 'usage' };
      }
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length > 1) return { format, check, strict, patch: null, err: 'usage' };
  return { format, check, strict, patch: positionals.length === 1 ? positionals[0] : null, err: null };
}
function detect(lines: string[]): string | null {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const m = /\S/.exec(lines[first]);
  if (m && (m[0] === '[' || m[0] === '{')) return 'json';
  for (let i = 0; i < lines.length; i++) {
    if (trailingTrim(lines[i]) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}
function loadTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string, prefix: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p, prefix + name + '/');
      else if (st.isFile()) out.set(prefix + name, readFileSync(p, 'utf8'));
    }
  };
  walk(dir, '');
  return out;
}
function out(s: string): void {
  process.stdout.write(s + '\n');
}

// ---------- unified diffs (section 6) ----------
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}
interface Hunk {
  a: number;
  body: BodyLine[];
}
interface UnifiedEdit {
  fmt: 'unified';
  oldP: string | null;
  newP: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}
function pairPath(raw: string): string | null {
  let p = raw;
  const tab = p.indexOf('\t');
  if (tab !== -1) p = p.slice(0, tab);
  p = trimSpaces(p);
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}
function parseGitLine(line: string): { a: string; b: string } {
  const rest = line.slice('diff --git '.length);
  const sp = rest.indexOf(' ');
  if (sp === -1) throw new ParseErr(0);
  const x = rest.slice(0, sp);
  const rem = rest.slice(sp + 1);
  if (!rem.startsWith('b/')) throw new ParseErr(0);
  let a = x;
  let b = rem.slice(2);
  if (a.startsWith('a/')) a = a.slice(2);
  return { a, b };
}
function parseUnified(lines: string[]): UnifiedEdit[] {
  const edits: UnifiedEdit[] = [];
  const n = lines.length;
  let cur: {
    pairOld: string | null | undefined;
    pairNew: string | null | undefined;
    gitA: string | undefined;
    gitB: string | undefined;
    renameFrom: string | undefined;
    renameTo: string | undefined;
    createMode: boolean;
    delMode: boolean;
    hunks: Hunk[];
    inHeader: boolean;
  } | null = null;
  const flush = (): void => {
    if (!cur) return;
    const oldP = cur.pairOld !== undefined ? cur.pairOld : cur.renameFrom !== undefined ? cur.renameFrom : cur.gitA !== undefined ? cur.gitA : '';
    const newP = cur.pairNew !== undefined ? cur.pairNew : cur.renameTo !== undefined ? cur.renameTo : cur.gitB !== undefined ? cur.gitB : '';
    const create = oldP === null || cur.createMode;
    const del = newP === null || cur.delMode;
    edits.push({
      fmt: 'unified',
      oldP,
      newP,
      create,
      del,
      hunks: cur.hunks,
    });
    cur = null;
  };
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      let g: { a: string; b: string };
      try {
        g = parseGitLine(line);
      } catch (e) {
        if (e instanceof ParseErr) throw new ParseErr(i + 1);
        throw e;
      }
      flush();
      cur = {
        pairOld: undefined,
        pairNew: undefined,
        gitA: g.a,
        gitB: g.b,
        renameFrom: undefined,
        renameTo: undefined,
        createMode: false,
        delMode: false,
        hunks: [],
        inHeader: true,
      };
      i++;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
      if (cur && cur.inHeader && cur.pairOld === undefined) {
        cur.pairOld = pairPath(line.slice(4));
        cur.pairNew = pairPath(lines[i + 1].slice(4));
        i += 2;
        continue;
      }
      flush();
      cur = {
        pairOld: pairPath(line.slice(4)),
        pairNew: pairPath(lines[i + 1].slice(4)),
        gitA: undefined,
        gitB: undefined,
        renameFrom: undefined,
        renameTo: undefined,
        createMode: false,
        delMode: false,
        hunks: [],
        inHeader: true,
      };
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (!cur) throw new ParseErr(i + 1);
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!hm) throw new ParseErr(i + 1);
      const hunk: Hunk = { a: parseInt(hm[1], 10), body: [] };
      cur.inHeader = false;
      let j = i + 1;
      while (j < n) {
        const l = lines[j];
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && j + 1 < n && lines[j + 1].startsWith('+++ ')) break;
        if (l === '') {
          hunk.body.push({ kind: 'ctx', text: '' });
          j++;
        } else if (l[0] === ' ') {
          hunk.body.push({ kind: 'ctx', text: l.slice(1) });
          j++;
        } else if (l[0] === '-') {
          hunk.body.push({ kind: 'old', text: l.slice(1) });
          j++;
        } else if (l[0] === '+') {
          hunk.body.push({ kind: 'new', text: l.slice(1) });
          j++;
        } else if (l[0] === '\\') {
          hunk.body.push({ kind: 'bs', text: l });
          j++;
        } else {
          break;
        }
      }
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1];
        if (last.kind === 'ctx' && last.text === '') hunk.body.pop();
        else break;
      }
      cur.hunks.push(hunk);
      i = j;
      continue;
    }
    if (cur && cur.inHeader) {
      if (line.startsWith('--- ')) throw new ParseErr(i + 2);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length);
      else if (line.startsWith('new file mode')) cur.createMode = true;
      else if (line.startsWith('deleted file mode')) cur.delMode = true;
      i++;
      continue;
    }
    i++;
  }
  flush();
  return edits;
}

// ---------- unified apply ----------
interface ApplyResult {
  ok: boolean;
  code?: string;
  path?: string;
  move?: { old: string; nw: string };
}
function hunkON(body: BodyLine[]): { O: string[]; nspec: NSpec[] } {
  const O: string[] = [];
  const nspec: NSpec[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      O.push(b.text);
      nspec.push({ text: b.text, ctx: O.length - 1 });
    } else if (b.kind === 'old') {
      O.push(b.text);
    } else if (b.kind === 'new') {
      nspec.push({ text: b.text, ctx: -1 });
    }
  }
  return { O, nspec };
}
function bsAfterLastCtxPlus(body: BodyLine[]): boolean | null {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i].kind === 'ctx' || body[i].kind === 'new') last = i;
  }
  if (last === -1) return null;
  return last + 1 < body.length && body[last + 1].kind === 'bs';
}
function applyUnified(tree: Map<string, string>, edit: UnifiedEdit, strict: boolean): ApplyResult {
  if (edit.oldP !== null && !isSafePath(edit.oldP)) return { ok: false, code: 'unsafe', path: edit.oldP };
  if (edit.newP !== null && !isSafePath(edit.newP)) return { ok: false, code: 'unsafe', path: edit.newP };
  if (edit.create && edit.newP === null) return { ok: false, code: 'unsafe', path: '' };
  if (edit.del && edit.oldP === null) return { ok: false, code: 'unsafe', path: '' };
  if (edit.create) {
    const np = edit.newP as string;
    if (tree.has(np)) return { ok: false, code: 'exists', path: np };
    const plus: string[] = [];
    let lastPlusHunk: Hunk | null = null;
    for (const h of edit.hunks) {
      if (h.body.some((b) => b.kind === 'new')) lastPlusHunk = h;
      for (const b of h.body) if (b.kind === 'new') plus.push(b.text);
    }
    let eol = plus.length > 0;
    if (lastPlusHunk) {
      const bs = bsAfterLastCtxPlus(lastPlusHunk.body);
      if (bs === true) eol = false;
    }
    const text = plus.length === 0 ? '' : plus.join('\n') + (eol ? '\n' : '');
    tree.set(np, text);
    return { ok: true };
  }
  if (edit.del) {
    const op = edit.oldP as string;
    if (!tree.has(op)) return { ok: false, code: 'missing', path: op };
    tree.delete(op);
    return { ok: true };
  }
  const op = edit.oldP as string;
  const np = edit.newP as string;
  const isMove = op !== np;
  if (!tree.has(op)) return { ok: false, code: 'missing', path: op };
  if (isMove && tree.has(np)) return { ok: false, code: 'exists', path: np };
  const doc = parseFile(tree.get(op) as string);
  let lines = [...doc.lines];
  let eol = doc.eol;
  let d = 0;
  for (const h of edit.hunks) {
    const { O, nspec } = hunkON(h.body);
    if (O.length === 0) {
      const idx = Math.min(Math.max(h.a + d, 0), lines.length);
      const newLines = buildNew(nspec, [], 0, O);
      if (idx === lines.length) {
        const bs = bsAfterLastCtxPlus(h.body);
        if (bs !== null) eol = !bs;
      }
      lines = [...lines.slice(0, idx), ...newLines, ...lines.slice(idx)];
      d += newLines.length;
    } else {
      const found = findTier(O, lines, strict, 0);
      if (!found) return { ok: false, code: 'no-match', path: op };
      const target = h.a - 1 + d;
      let best = found.pos[0];
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const pos = best;
      if (pos + O.length === lines.length) {
        const bs = bsAfterLastCtxPlus(h.body);
        if (bs !== null) eol = !bs;
      }
      const newLines = buildNew(nspec, lines.slice(pos, pos + O.length), found.tier, O);
      lines = [...lines.slice(0, pos), ...newLines, ...lines.slice(pos + O.length)];
      d += newLines.length - O.length;
    }
  }
  const text = serializeFile(lines, doc.brk, eol);
  if (isMove) {
    tree.delete(op);
    tree.set(np, text);
    return { ok: true, move: { old: op, nw: np } };
  }
  tree.set(op, text);
  return { ok: true };
}

// ---------- SEARCH/REPLACE blocks (section 7) ----------
interface SREdit {
  fmt: 'sr';
  path: string;
  oldLines: string[];
  newLines: string[];
}
function parseSR(lines: string[]): SREdit[] {
  const edits: SREdit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (trailingTrim(lines[i]) === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let path: string | null = null;
      for (let j = i - 1; j >= prevEnd; j--) {
        const t = lines[j];
        if (isBlank(t)) continue;
        if (t.trim().startsWith('```')) continue;
        path = t.trim();
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new ParseErr(searchLine);
        path = prevPath;
      }
      let j = i + 1;
      let eqIdx = -1;
      while (j < lines.length) {
        const tt = trailingTrim(lines[j]);
        if (tt === '=======') {
          eqIdx = j;
          break;
        }
        if (tt === '>>>>>>> REPLACE' || tt === '<<<<<<< SEARCH') throw new ParseErr(searchLine);
        j++;
      }
      if (eqIdx === -1) throw new ParseErr(searchLine);
      let k = eqIdx + 1;
      let endIdx = -1;
      while (k < lines.length) {
        const tt = trailingTrim(lines[k]);
        if (tt === '>>>>>>> REPLACE') {
          endIdx = k;
          break;
        }
        if (tt === '<<<<<<< SEARCH') throw new ParseErr(searchLine);
        k++;
      }
      if (endIdx === -1) throw new ParseErr(searchLine);
      edits.push({ fmt: 'sr', path, oldLines: lines.slice(i + 1, eqIdx), newLines: lines.slice(eqIdx + 1, endIdx) });
      prevPath = path;
      prevEnd = endIdx + 1;
      i = endIdx + 1;
    } else {
      i++;
    }
  }
  return edits;
}
function applySR(tree: Map<string, string>, edit: SREdit, strict: boolean): ApplyResult {
  if (!isSafePath(edit.path)) return { ok: false, code: 'unsafe', path: edit.path };
  if (edit.oldLines.length === 0) {
    if (tree.has(edit.path)) return { ok: false, code: 'exists', path: edit.path };
    const text = edit.newLines.length === 0 ? '' : edit.newLines.join('\n') + '\n';
    tree.set(edit.path, text);
    return { ok: true };
  }
  const cur = tree.get(edit.path);
  if (cur === undefined) return { ok: false, code: 'missing', path: edit.path };
  const doc = parseFile(cur);
  const found = findTier(edit.oldLines, doc.lines, strict, 0);
  if (!found) return { ok: false, code: 'no-match', path: edit.path };
  if (found.pos.length !== 1) return { ok: false, code: 'ambiguous', path: edit.path };
  const pos = found.pos[0];
  const nspec = edit.newLines.map((t) => ({ text: t, ctx: -1 }));
  const newLines = buildNew(nspec, doc.lines.slice(pos, pos + edit.oldLines.length), found.tier, edit.oldLines);
  const lines = [...doc.lines.slice(0, pos), ...newLines, ...doc.lines.slice(pos + edit.oldLines.length)];
  tree.set(edit.path, serializeFile(lines, doc.brk, doc.eol));
  return { ok: true };
}

// ---------- V4A patches (section 8) ----------
interface VChunk {
  anchor: string;
  eof: boolean;
  body: string[];
}
type V4AEdit =
  | { fmt: 'v4a-add'; path: string; lines: string[] }
  | { fmt: 'v4a-del'; path: string }
  | { fmt: 'v4a-update'; path: string; moveTo: string | null; chunks: VChunk[] };
function isSectionStart(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}
function parseV4A(lines: string[]): V4AEdit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) throw new ParseErr(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseErr(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i])) {
      last = i;
      break;
    }
  }
  if (last === -1 || lines[last].trim() !== '*** End Patch') throw new ParseErr(lines.length + 1);
  const edits: V4AEdit[] = [];
  let i = first + 1;
  const end = last;
  while (i < end) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = trimSpaces(line.slice('*** Add File: '.length));
      const secStart = i + 1;
      let j = secStart;
      while (j < end && !isSectionStart(lines[j])) j++;
      let k = j;
      while (k > secStart && isBlank(lines[k - 1])) k--;
      const secLines = lines.slice(secStart, k);
      for (let m = 0; m < secLines.length; m++) {
        const l = secLines[m];
        if (l === '' || l.startsWith('+')) continue;
        throw new ParseErr(secStart + m + 1);
      }
      edits.push({ fmt: 'v4a-add', path, lines: secLines.map((l) => (l === '' ? '' : l.slice(1))) });
      i = j;
    } else if (line.startsWith('*** Delete File: ')) {
      const path = trimSpaces(line.slice('*** Delete File: '.length));
      let j = i + 1;
      while (j < end && !isSectionStart(lines[j])) {
        if (!isBlank(lines[j])) throw new ParseErr(j + 1);
        j++;
      }
      edits.push({ fmt: 'v4a-del', path });
      i = j;
    } else if (line.startsWith('*** Update File: ')) {
      const path = trimSpaces(line.slice('*** Update File: '.length));
      let j = i + 1;
      let moveTo: string | null = null;
      if (j < end && lines[j].startsWith('*** Move to: ')) {
        moveTo = trimSpaces(lines[j].slice('*** Move to: '.length));
        j++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let afterEof = false;
      while (j < end && !isSectionStart(lines[j])) {
        const l = lines[j];
        if (l === '*** End of File') {
          if (!cur) throw new ParseErr(j + 1);
          cur.eof = true;
          cur = null;
          afterEof = true;
          j++;
          continue;
        }
        if (l.startsWith('@@')) {
          cur = { anchor: trimSpaces(l.slice(2)), eof: false, body: [] };
          chunks.push(cur);
          afterEof = false;
          j++;
          continue;
        }
        if (l.startsWith('*** Move to: ')) throw new ParseErr(j + 1);
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (!cur) {
            if (chunks.length === 0 && !afterEof) {
              cur = { anchor: '', eof: false, body: [] };
              chunks.push(cur);
            } else {
              throw new ParseErr(j + 1);
            }
          }
          cur.body.push(l);
          j++;
          continue;
        }
        throw new ParseErr(j + 1);
      }
      if (cur) {
        while (cur.body.length > 0 && isBlank(cur.body[cur.body.length - 1])) cur.body.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseErr(i + 1);
      edits.push({ fmt: 'v4a-update', path, moveTo, chunks });
      i = j;
    } else {
      throw new ParseErr(i + 1);
    }
  }
  return edits;
}

function chunkON(body: string[]): { O: string[]; nspec: NSpec[] } {
  const O: string[] = [];
  const nspec: NSpec[] = [];
  for (const l of body) {
    if (l === '') {
      O.push('');
      nspec.push({ text: '', ctx: O.length - 1 });
    } else if (l[0] === ' ') {
      const t = l.slice(1);
      O.push(t);
      nspec.push({ text: t, ctx: O.length - 1 });
    } else if (l[0] === '-') {
      O.push(l.slice(1));
    } else if (l[0] === '+') {
      nspec.push({ text: l.slice(1), ctx: -1 });
    }
  }
  return { O, nspec };
}
function findSingleLine(anchor: string, lines: string[], strict: boolean, from: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(anchor, lines[i], t)) return i;
    }
  }
  return null;
}
function eofTier(O: string[], lines: string[], strict: boolean, pos: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(O[j], lines[pos + j], t)) {
        ok = false;
        break;
      }
    }
    if (ok) return t;
  }
  return null;
}
function applyV4A(tree: Map<string, string>, edit: V4AEdit, strict: boolean): ApplyResult {
  if (edit.fmt === 'v4a-add') {
    if (!isSafePath(edit.path)) return { ok: false, code: 'unsafe', path: edit.path };
    if (tree.has(edit.path)) return { ok: false, code: 'exists', path: edit.path };
    const text = edit.lines.length === 0 ? '' : edit.lines.join('\n') + '\n';
    tree.set(edit.path, text);
    return { ok: true };
  }
  if (edit.fmt === 'v4a-del') {
    if (!isSafePath(edit.path)) return { ok: false, code: 'unsafe', path: edit.path };
    if (!tree.has(edit.path)) return { ok: false, code: 'missing', path: edit.path };
    tree.delete(edit.path);
    return { ok: true };
  }
  if (!isSafePath(edit.path)) return { ok: false, code: 'unsafe', path: edit.path };
  if (edit.moveTo !== null && !isSafePath(edit.moveTo)) return { ok: false, code: 'unsafe', path: edit.moveTo };
  const cur = tree.get(edit.path);
  if (cur === undefined) return { ok: false, code: 'missing', path: edit.path };
  if (edit.moveTo !== null && tree.has(edit.moveTo)) return { ok: false, code: 'exists', path: edit.moveTo };
  const doc = parseFile(cur);
  let lines = [...doc.lines];
  let cursor = 0;
  for (const ch of edit.chunks) {
    if (ch.anchor !== '') {
      const a = findSingleLine(ch.anchor, lines, strict, cursor);
      if (a === null) return { ok: false, code: 'no-match', path: edit.path };
      cursor = a + 1;
    }
    const { O, nspec } = chunkON(ch.body);
    if (O.length === 0) {
      const idx = ch.eof ? lines.length : cursor;
      const newLines = buildNew(nspec, [], 0, O);
      lines = [...lines.slice(0, idx), ...newLines, ...lines.slice(idx)];
      cursor = idx + newLines.length;
    } else if (ch.eof) {
      const pos = lines.length - O.length;
      if (pos < cursor) return { ok: false, code: 'no-match', path: edit.path };
      const tier = eofTier(O, lines, strict, pos);
      if (tier === null) return { ok: false, code: 'no-match', path: edit.path };
      const newLines = buildNew(nspec, lines.slice(pos, pos + O.length), tier, O);
      lines = [...lines.slice(0, pos), ...newLines, ...lines.slice(pos + O.length)];
      cursor = pos + newLines.length;
    } else {
      const found = findTier(O, lines, strict, cursor);
      if (!found) return { ok: false, code: 'no-match', path: edit.path };
      const pos = found.pos[0];
      const newLines = buildNew(nspec, lines.slice(pos, pos + O.length), found.tier, O);
      lines = [...lines.slice(0, pos), ...newLines, ...lines.slice(pos + O.length)];
      cursor = pos + newLines.length;
    }
  }
  const text = serializeFile(lines, doc.brk, doc.eol);
  if (edit.moveTo !== null) {
    tree.delete(edit.path);
    tree.set(edit.moveTo, text);
    return { ok: true, move: { old: edit.path, nw: edit.moveTo } };
  }
  tree.set(edit.path, text);
  return { ok: true };
}

// ---------- JSON edits (section 9) ----------
interface JSONEdit {
  fmt: 'json';
  obj: Record<string, unknown>;
  line: number;
}
function validateJSONObj(obj: unknown, lineNo: number): JSONEdit {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new ParseErr(lineNo);
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') throw new ParseErr(lineNo);
  if (o.command !== 'create' && o.command !== 'str_replace' && o.command !== 'insert') throw new ParseErr(lineNo);
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') throw new ParseErr(lineNo);
  } else if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') throw new ParseErr(lineNo);
    if (o.new_str !== undefined && typeof o.new_str !== 'string') throw new ParseErr(lineNo);
  } else if (o.command === 'insert') {
    if (!Number.isInteger(o.insert_line)) throw new ParseErr(lineNo);
    if (typeof o.new_str !== 'string') throw new ParseErr(lineNo);
  }
  return { fmt: 'json', obj: o, line: lineNo };
}
function parseJSON(patchText: string, lines: string[]): JSONEdit[] {
  const m = /\S/.exec(patchText);
  if (!m) return [];
  const firstCh = m[0];
  const startLine = patchText.slice(0, m.index).split('\n').length;
  if (firstCh === '[') {
    let arr: unknown;
    try {
      arr = JSON.parse(patchText);
    } catch {
      throw new ParseErr(startLine);
    }
    if (!Array.isArray(arr)) throw new ParseErr(startLine);
    return arr.map((el) => validateJSONObj(el, startLine));
  }
  const edits: JSONEdit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (isBlank(l)) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(l);
    } catch {
      throw new ParseErr(i + 1);
    }
    edits.push(validateJSONObj(obj, i + 1));
  }
  return edits;
}
function applyJSON(tree: Map<string, string>, edit: JSONEdit): ApplyResult {
  const o = edit.obj;
  const path = o.path as string;
  if (!isSafePath(path)) return { ok: false, code: 'unsafe', path };
  if (o.command === 'create') {
    if (tree.has(path)) return { ok: false, code: 'exists', path };
    tree.set(path, o.file_text as string);
    return { ok: true };
  }
  if (o.command === 'str_replace') {
    const cur = tree.get(path);
    if (cur === undefined) return { ok: false, code: 'missing', path };
    let oldStr = o.old_str as string;
    let newStr = o.new_str === undefined ? '' : (o.new_str as string);
    const doc = parseFile(cur);
    let text = cur;
    const isCrlf = doc.brk === '\r\n';
    if (isCrlf) {
      text = text.replace(/\r\n/g, '\n');
      oldStr = oldStr.replace(/\r\n/g, '\n');
      newStr = newStr.replace(/\r\n/g, '\n');
    }
    let count = 0;
    let first = -1;
    let idx = text.indexOf(oldStr, 0);
    while (idx !== -1) {
      count++;
      if (first === -1) first = idx;
      idx = text.indexOf(oldStr, idx + 1);
    }
    if (count === 0) return { ok: false, code: 'no-match', path };
    if (count >= 2) return { ok: false, code: 'ambiguous', path };
    let result = text.slice(0, first) + newStr + text.slice(first + oldStr.length);
    if (isCrlf) result = result.replace(/\n/g, '\r\n');
    tree.set(path, result);
    return { ok: true };
  }
  const cur = tree.get(path);
  if (cur === undefined) return { ok: false, code: 'missing', path };
  const doc = parseFile(cur);
  const lineNo = o.insert_line as number;
  if (lineNo < 0 || lineNo > doc.lines.length) return { ok: false, code: 'no-match', path };
  const newLines = splitPatchLines(o.new_str as string);
  const lines = [...doc.lines.slice(0, lineNo), ...newLines, ...doc.lines.slice(lineNo)];
  tree.set(path, serializeFile(lines, doc.brk, doc.eol));
  return { ok: true };
}

// ---------- driver (sections 2 and 10) ----------
type Edit = UnifiedEdit | SREdit | V4AEdit | JSONEdit;
function applyEdit(tree: Map<string, string>, edit: Edit, strict: boolean): ApplyResult {
  if (edit.fmt === 'unified') return applyUnified(tree, edit, strict);
  if (edit.fmt === 'sr') return applySR(tree, edit, strict);
  if (edit.fmt === 'json') return applyJSON(tree, edit);
  return applyV4A(tree, edit, strict);
}
function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.err === 'usage') {
    out('error: usage');
    process.exitCode = 2;
    return;
  }
  let patchText: string;
  if (args.patch === null || args.patch === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      const st = statSync(args.patch);
      if (!st.isFile()) throw new Error('not a file');
      patchText = readFileSync(args.patch, 'utf8');
    } catch {
      out('error: no-patch');
      process.exitCode = 2;
      return;
    }
  }
  const lines = splitPatchLines(patchText);
  let fmt = args.format;
  if (fmt === 'auto') {
    const d = detect(lines);
    if (d === null) {
      out('error: format');
      process.exitCode = 2;
      return;
    }
    fmt = d;
  }
  let edits: Edit[];
  try {
    if (fmt === 'unified') edits = parseUnified(lines);
    else if (fmt === 'search-replace') edits = parseSR(lines);
    else if (fmt === 'v4a') edits = parseV4A(lines);
    else edits = parseJSON(patchText, lines);
  } catch (e) {
    if (e instanceof ParseErr) {
      out('error: parse ' + e.line);
      process.exitCode = 2;
      return;
    }
    throw e;
  }
  if (edits.length === 0) {
    out('error: parse 1');
    process.exitCode = 2;
    return;
  }
  const orig = loadTree(process.cwd());
  const tree = new Map(orig);
  const failures: { code: string; path: string }[] = [];
  const moves: { old: string; nw: string }[] = [];
  for (const ed of edits) {
    const r = applyEdit(tree, ed, args.strict);
    if (!r.ok) failures.push({ code: r.code as string, path: r.path as string });
    else if (r.move) moves.push(r.move);
  }
  if (failures.length > 0) {
    for (const f of failures) out(`error: ${f.code} ${f.path}`);
    out(`failed: ${failures.length} of ${edits.length} edits`);
    process.exitCode = 1;
    return;
  }
  const outLines: { key: string; line: string }[] = [];
  const rOld = new Set<string>();
  const aNew = new Set<string>();
  for (const m of moves) {
    if (orig.has(m.old) && !tree.has(m.old) && !orig.has(m.nw) && tree.has(m.nw)) {
      outLines.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
      rOld.add(m.old);
      aNew.add(m.nw);
    }
  }
  const allPaths = new Set([...orig.keys(), ...tree.keys()]);
  for (const p of allPaths) {
    const inOrig = orig.has(p);
    const inFinal = tree.has(p);
    if (!inOrig && inFinal && !aNew.has(p)) outLines.push({ key: p, line: `A ${p}` });
    else if (inOrig && !inFinal && !rOld.has(p)) outLines.push({ key: p, line: `D ${p}` });
    else if (inOrig && inFinal && orig.get(p) !== tree.get(p)) outLines.push({ key: p, line: `M ${p}` });
  }
  outLines.sort((a, b) => byteCmp(a.key, b.key));
  for (const l of outLines) out(l.line);
  out(outLines.length === 1 ? 'ok: 1 file' : `ok: ${outLines.length} files`);
  process.exitCode = 0;
  if (!args.check) {
    for (const p of allPaths) {
      const inOrig = orig.has(p);
      const inFinal = tree.has(p);
      if (!inFinal) {
        if (inOrig) rmSync(join(process.cwd(), ...p.split('/')), { force: true });
      } else if (!inOrig || orig.get(p) !== tree.get(p)) {
        const f = join(process.cwd(), ...p.split('/'));
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, tree.get(p) as string);
      }
    }
  }
}
main();
