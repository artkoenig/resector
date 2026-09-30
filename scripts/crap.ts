// CRAP gate: complexity from the TypeScript AST, line coverage from Bun's LCOV.
// CRAP(f) = c² · (1 − cov)³ + c. Fails when any function scores above --max.
// Bun's LCOV has no per-function records, so crap-ts (Istanbul fnMap) can't read it.
import * as ts from 'typescript';
import { Glob } from 'bun';
import { parseArgs } from 'node:util';
import { relative, resolve } from 'node:path';

const { values } = parseArgs({
  options: {
    lcov: { type: 'string', default: 'coverage/lcov.info' },
    src: { type: 'string', default: 'src' },
    max: { type: 'string', default: '8' },
  },
});
const max = Number(values.max);
if (!Number.isFinite(max)) throw new Error(`--max must be a number, got ${values.max}`);
const norm = (p: string) => relative(process.cwd(), resolve(p));

const hits = new Map<string, Map<number, number>>();
let current: Map<number, number> | undefined;
for (const line of (await Bun.file(values.lcov).text()).split('\n')) {
  if (line.startsWith('SF:')) hits.set(norm(line.slice(3)), (current = new Map()));
  else if (line.startsWith('DA:') && current) {
    const [ln, n] = line.slice(3).split(',').map(Number);
    current.set(ln!, n!);
  }
}

const isFunction = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) ||
  ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) ||
  ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n);

const DECISION = new Set([
  ts.SyntaxKind.IfStatement, ts.SyntaxKind.ConditionalExpression, ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.ForStatement, ts.SyntaxKind.ForInStatement, ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement, ts.SyntaxKind.DoStatement, ts.SyntaxKind.CatchClause,
]);
const LOGICAL = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

const lineOf = (sf: ts.SourceFile, pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;

function nameOf(fn: ts.FunctionLikeDeclaration): string {
  if (fn.name) return fn.name.getText();
  const parent = fn.parent;
  if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) return parent.name.getText();
  return '<anonymous>';
}

// Lines owned by nested functions (after their first line, which the parent statement shares).
function nestedLines(fn: ts.Node, sf: ts.SourceFile): Set<number> {
  const owned = new Set<number>();
  const visit = (n: ts.Node): void => {
    if (n !== fn && isFunction(n)) {
      for (let ln = lineOf(sf, n.getStart()) + 1; ln <= lineOf(sf, n.getEnd()); ln++) owned.add(ln);
      return;
    }
    n.forEachChild(visit);
  };
  visit(fn);
  return owned;
}

function complexity(fn: ts.Node): number {
  let cyclomatic = 1;
  const visit = (n: ts.Node): void => {
    if (n !== fn && isFunction(n)) return;
    if (DECISION.has(n.kind)) cyclomatic++;
    if (ts.isBinaryExpression(n) && LOGICAL.has(n.operatorToken.kind)) cyclomatic++;
    n.forEachChild(visit);
  };
  visit(fn);
  return cyclomatic;
}

type Row = { location: string; complexity: number; coverage: number; crap: number };
const rows: Row[] = [];
for await (const file of new Glob(`${values.src}/**/*.{ts,tsx}`).scan()) {
  if (/\.test\.tsx?$/.test(file)) continue;
  const sf = ts.createSourceFile(file, await Bun.file(file).text(), ts.ScriptTarget.Latest, true);
  // A file missing from LCOV was never loaded by a test: 0 % coverage.
  const lineHits = hits.get(norm(file)) ?? new Map<number, number>();
  const visit = (n: ts.Node): void => {
    if (isFunction(n)) {
      const from = lineOf(sf, n.getStart()), to = lineOf(sf, n.getEnd());
      const nested = nestedLines(n, sf);
      const lines = [...lineHits].filter(([ln]) => ln >= from && ln <= to && !nested.has(ln));
      // A loaded file whose function has no lines in LCOV: Bun's source map dropped them (seen for one-line arrows
      // in .tsx), not uncovered – an uncovered line is listed with 0 hits.
      const unmapped = !lines.length && lineHits.size > 0;
      const coverage = lines.length ? lines.filter(([, h]) => h > 0).length / lines.length : unmapped ? 1 : 0;
      const c = complexity(n);
      rows.push({ location: `${norm(file)}:${from} ${nameOf(n)}`, complexity: c, coverage,
        crap: c * c * (1 - coverage) ** 3 + c });
    }
    n.forEachChild(visit);
  };
  visit(sf);
}

rows.sort((a, b) => b.crap - a.crap);
const failing = rows.filter(r => r.crap > max);
for (const r of rows.slice(0, Math.max(10, failing.length)))
  console.log(`${r.crap.toFixed(1).padStart(6)}  c=${r.complexity}  cov=${(r.coverage * 100).toFixed(0)}%  ${r.location}`);
console.log(`${rows.length} functions, ${failing.length} above CRAP ${max}`);
process.exit(failing.length ? 1 : 0);
