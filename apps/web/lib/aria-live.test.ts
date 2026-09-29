/**
 * A-145 (C4, D-70). AN `aria-live` ELEMENT THAT MOUNTS WITH ITS TEXT ALREADY
 * INSIDE IT IS SILENT — the region has to exist in the accessibility tree
 * before the text lands, or nothing is announced. This codebase's fifteen-lens
 * sweep (docs/reviews/30-five-lens-review.md, C4) found the same shape
 * repeated across the staff surfaces: `{state.message ? <p aria-live=...>...
 * </p> : null}`. Every one compiled, every one passed its own component test,
 * and axe has no opinion about an element that was never wrong once it
 * existed — the bug is entirely about the render BEFORE the one axe sees.
 *
 * THE FIX IS ALWAYS THE SAME SHAPE (`status-actions.tsx`'s pattern): the
 * element is unconditional, and only its CONTENT is conditional —
 * `<p aria-live="polite">{state.message ?? ''}</p>`. So the guard is not
 * "does this element ever render empty", it is "can this element's own
 * MOUNTING depend on a condition" — a ternary or `&&` where the aria-live
 * element ITSELF is the gated side (mod a bare `(...)` or single-child
 * fragment) and the other side is `null`/`undefined`. A gate several tags up
 * that removes a WHOLE PANEL (`pushFrom ? <details>...</details> : null` — no
 * push to preview at all) is a different question and stays unflagged; the
 * live region inside it is still unconditional relative to the panel's own
 * async result, which is what a screen reader needs.
 *
 * ONE DELIBERATE EXCEPTION, not an allowlist entry: `components/ui/field.tsx`
 * gates its error paragraph on `error === undefined` rather than on
 * truthiness, exactly so a field that cannot fail renders no element at all
 * (its own comment: "the rule is about `undefined` rather than about
 * truthiness"). Every real defect this test was written for gates on
 * TRUTHINESS (`state.message ?`, `state.message && !state.ok`, `if (!state.ok)
 * return null`) — none of them are an explicit `=== undefined` check — so the
 * guard exempts that one comparison shape rather than that one file. A caller
 * of `Field` that forgets `error ?? ''` still mounts the element late; that
 * risk is Field's own documented contract, not a shape a parser can see from
 * inside `field.tsx`.
 *
 * TEST FILES ARE OUT OF SCOPE, same as `voice.test.ts` — a fixture's aria-live
 * narration never reaches a screen.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

const ROOTS = ['apps/web/app', 'apps/web/components', 'apps/web/lib', 'packages/core', 'packages/db'];

const SKIP_DIR = new Set(['node_modules', 'generated', '.next', 'migrations', 'test-results']);

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

function isUndefinedLiteral(node: ts.Node): boolean {
  return ts.isIdentifier(node) && node.text === 'undefined';
}

/** Field's own exemption: `x === undefined` / `x !== undefined`, either
 *  operand order. Nothing else reads as this shape. */
function isUndefinedCheck(expr: ts.Expression): boolean {
  if (!ts.isBinaryExpression(expr)) return false;
  const eq = [
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken,
  ];
  if (!eq.includes(expr.operatorToken.kind)) return false;
  return isUndefinedLiteral(expr.left) || isUndefinedLiteral(expr.right);
}

function isNullish(node: ts.Node): boolean {
  return node.kind === ts.SyntaxKind.NullKeyword || isUndefinedLiteral(node);
}

/**
 * Is `element` ITSELF — not merely something nested somewhere inside a larger
 * subtree — the gated side of a truthiness ternary or `&&` whose other side
 * renders nothing? Climbing passes through a bare wrapping `(...)` or a
 * fragment holding nothing else, because those are not a container with a
 * life of its own. Reaching any REAL tag (a `<div>`, a `<details>`, anything
 * with its own other children) stops the climb without flagging: that is a
 * whole panel that does or does not apply to this render — `pushFrom === null`
 * meaning "nothing left to push" — not an async result flickering the one
 * region inside it, which is the only shape this test is for.
 */
function isConditionallyMounted(element: ts.Node): boolean {
  let current: ts.Node = element;
  for (;;) {
    const parent: ts.Node | undefined = current.parent;
    if (!parent) return false;
    if (ts.isParenthesizedExpression(parent)) {
      current = parent;
      continue;
    }
    if (ts.isJsxFragment(parent)) {
      const meaningful = parent.children.filter((c) => !(ts.isJsxText(c) && c.text.trim() === ''));
      if (meaningful.length === 1 && meaningful[0] === current) {
        current = parent;
        continue;
      }
      return false;
    }
    if (ts.isConditionalExpression(parent)) {
      const onConsequent = parent.whenTrue === current;
      const onAlternate = parent.whenFalse === current;
      if ((onConsequent || onAlternate) && !isUndefinedCheck(parent.condition)) {
        const other = onConsequent ? parent.whenFalse : parent.whenTrue;
        if (isNullish(other)) return true;
      }
      return false;
    }
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      if (parent.right === current && !isUndefinedCheck(parent.left)) return true;
      return false;
    }
    return false;
  }
}

function ariaLiveOffenders(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const hits: string[] = [];

  const isAriaLiveTag = (el: ts.JsxOpeningElement | ts.JsxSelfClosingElement): boolean =>
    el.attributes.properties.some((p) => ts.isJsxAttribute(p) && ts.isIdentifier(p.name) && p.name.text === 'aria-live');

  const visit = (node: ts.Node): void => {
    if (ts.isJsxSelfClosingElement(node) && isAriaLiveTag(node) && isConditionallyMounted(node)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      hits.push(`${relative(REPO_ROOT, file)}:${line + 1}`);
    }
    if (ts.isJsxOpeningElement(node) && isAriaLiveTag(node) && isConditionallyMounted(node.parent)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      hits.push(`${relative(REPO_ROOT, file)}:${line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

describe('an aria-live element is never conditionally mounted', () => {
  // A-096's rule: a green run over nothing looks exactly like a green run.
  it('reads the whole rendered surface', () => {
    const files = ROOTS.flatMap((root) => sourceFiles(join(REPO_ROOT, root)));
    expect(files.length).toBeGreaterThan(150);
    expect(files.map((f) => relative(REPO_ROOT, f))).toContain(
      join('apps', 'web', 'app', 'staff', 'day', 'status-actions.tsx'),
    );
  });

  it('fires on the defect it was written for, and ignores Field\'s own contract', () => {
    const probe = join(REPO_ROOT, 'apps/web/lib/__aria_live_probe__.tsx');
    const text = [
      "export const Bug = ({ state }: any) =>",
      '  state.message ? <p aria-live="polite">{state.message}</p> : null;',
      '',
      "export const AlsoBug = ({ state }: any) => (",
      "  <div>{state.message && !state.ok ? <span aria-live=\"polite\">{state.message}</span> : null}</div>",
      ');',
      '',
      '// The one exempted shape: gated on `undefined`, not on truthiness.',
      'export const FieldsErrorSlot = ({ error }: any) =>',
      '  error === undefined ? null : <p aria-live="polite">{error}</p>;',
      '',
      'export const Correct = ({ state }: any) => <p aria-live="polite">{state.message ?? \'\'}</p>;',
      '',
      '// A whole panel that does not apply to this render (`pushFrom` null),',
      '// not an async result flickering the region inside it — must NOT fire.',
      'export const WholePanelGate = ({ pushFrom, pushState }: any) =>',
      '  pushFrom ? (',
      '    <details><div><p aria-live="polite">{pushState.message ?? \'\'}</p></div></details>',
      '  ) : null;',
    ].join('\n');
    const source = ts.createSourceFile(probe, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const found: string[] = [];
    const isAriaLiveTag = (el: ts.JsxOpeningElement | ts.JsxSelfClosingElement): boolean =>
      el.attributes.properties.some((p) => ts.isJsxAttribute(p) && ts.isIdentifier(p.name) && p.name.text === 'aria-live');
    const visit = (node: ts.Node): void => {
      if (ts.isJsxSelfClosingElement(node) && isAriaLiveTag(node) && isConditionallyMounted(node)) found.push('self-closing');
      if (ts.isJsxOpeningElement(node) && isAriaLiveTag(node) && isConditionallyMounted(node.parent)) found.push('opening');
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(found).toEqual(['opening', 'opening']);
  });

  it('has no conditionally-mounted aria-live element anywhere', () => {
    const offenders = ROOTS.flatMap((root) => sourceFiles(join(REPO_ROOT, root))).flatMap(ariaLiveOffenders);
    expect(offenders).toEqual([]);
  });
});
