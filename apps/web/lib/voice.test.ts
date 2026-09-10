/**
 * A-111. THE PRODUCT HAS NO GENDERED VOICE — enforced, not remembered.
 *
 * The defect this exists to prevent: `/staff/unfinished` shipped two buttons
 * reading "She came" and "She didn't" under every one of 124 rows, and the
 * same voice was on twelve more staff surfaces — worst of them the client
 * record's "She cannot book online — the desk can", which the desk reads down
 * the phone to the person it is about. Two of thirteen seeded clients are men
 * and they hold 23.8% of the book. The product does not store, ask for, or
 * infer gender for anybody.
 *
 * NOTHING CAUGHT IT AND NOTHING COULD: it compiles, 1,590 unit and 305 e2e
 * tests passed, axe does not read English, and the design gallery rendered the
 * same strings and called them correct. So the guard has to be a scan of the
 * source, and it has to run in the gate.
 *
 * NO ALLOWLIST, ON PURPOSE — and the backlog row was wrong about this. It
 * scoped the sweep to CLIENT copy, on the reasoning that "her working hours"
 * about Dana or Tess is correct. But `setup-seed.ts` seeds Marcus, one stylist
 * in four, and `scheduling-words.ts` renders "outside her working hours" about
 * whichever provider the engine names. An exemption list here would have held
 * exactly the ~20 strings that are wrong about him, which is CLAUDE.md's
 * A-096 rule — patching the rooms that noticed leaves the door open — arriving
 * as a config file. Zero pronouns in rendered copy is the only line that does
 * not need maintaining.
 *
 * WHY A TEST AND NOT LINT. `no-restricted-syntax` with a `Literal[value=/…/]`
 * selector would do the detection, but ESLint rule config REPLACES rather than
 * merges, so covering both eslint configs while exempting test narration meant
 * four override blocks each re-listing the D-3 axis selectors — a shape where
 * the next person to add a block silently drops one set. This is one file.
 *
 * TEST FILES AND E2E SPECS ARE OUT OF SCOPE. A test title narrating "she books
 * at 09:00" about a specific fictional client is not the product's voice; it
 * never reaches a screen.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

/** Everything that can put a sentence in front of a human. */
const ROOTS = ['apps/web/app', 'apps/web/components', 'apps/web/lib', 'packages/core', 'packages/db'];

const SKIP_DIR = new Set(['node_modules', 'generated', '.next', 'migrations', 'test-results']);

const PRONOUN = /\b(she|her|hers|herself|he|him|his|himself)\b/i;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIR.has(entry.name)) out.push(...sourceFiles(path));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue;
    out.push(path);
  }
  return out;
}

/**
 * Every string a reader could see: string literals (JSX attribute values
 * included), the literal chunks of template strings, and JSX text. Comments
 * are not nodes, so they fall out for free — which is the whole reason this
 * parses rather than greps. The codebase narrates in comments constantly.
 */
function gendered(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const hits: string[] = [];

  const visit = (node: ts.Node): void => {
    const copy =
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
        ? node.text
        : ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
          ? node.text
          : ts.isJsxText(node)
            ? node.text
            : null;
    if (copy !== null && PRONOUN.test(copy)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      hits.push(`${relative(REPO_ROOT, file)}:${line + 1}  ${copy.replace(/\s+/g, ' ').trim()}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

describe('the product speaks about nobody by gender', () => {
  // A-096's rule: a green run over nothing looks exactly like a green run.
  // Both halves are asserted — that the scan reached real files, and that the
  // detector fires on the string this item was opened for while ignoring the
  // same words in a comment.
  it('reads the whole rendered surface', () => {
    const files = ROOTS.flatMap((root) => sourceFiles(join(REPO_ROOT, root)));
    expect(files.length).toBeGreaterThan(150);
    expect(files.map((f) => relative(REPO_ROOT, f))).toContain(
      join('apps', 'web', 'app', 'staff', 'unfinished', 'close-out-buttons.tsx'),
    );
  });

  it('would fire on the defect it was written for', () => {
    const probe = join(REPO_ROOT, 'apps/web/lib/__voice_probe__.tsx');
    const text = '// she came, and the desk said so\nexport const P = () => <p title="She came">She came</p>;\n';
    const source = ts.createSourceFile(probe, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      const copy = ts.isStringLiteral(node) ? node.text : ts.isJsxText(node) ? node.text : null;
      if (copy !== null && PRONOUN.test(copy)) found.push(copy);
      ts.forEachChild(node, visit);
    };
    visit(source);
    // The attribute and the text, and NOT the comment above them.
    expect(found).toEqual(['She came', 'She came']);
  });

  it('has no gendered pronoun in any string a human reads', () => {
    const offenders = ROOTS.flatMap((root) => sourceFiles(join(REPO_ROOT, root))).flatMap(gendered);
    expect(offenders).toEqual([]);
  });
});
