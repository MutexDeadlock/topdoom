/**
 * Checks a `.ts` file Claude just wrote against the mechanical half of docs/conventions.md and
 * CLAUDE.md, and reports what it finds back to Claude (exit 2, stderr). Wired as a PostToolUse
 * hook in .claude/settings.json.
 *
 * It is agent tooling, not a linter: no npm script runs it, it gates nothing, and it never sees a
 * file a human edits. Only rules a machine can decide are here — everything about what a comment
 * *says* stays a reading job. Run it by hand with `node .claude/hooks/conventions.mjs <file>`.
 */
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const TEXT_EXTS = /\.(ts|css|html|json|md|glsl|wad|txt)$/;

/** Files whose shape docs/conventions.md § Source order exempts: a data module lists, not runs. */
const DATA_MODULE = /(^|\/)(tables|defs|doomednums|states)\.ts$/;

const path = await targetPath();
if (path) report(path, check(path));

/** The file to check: the hook's JSON payload on stdin, or an argument when run by hand. */
async function targetPath() {
  if (process.argv[2]) return resolve(process.argv[2]);
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  const file = payload?.tool_input?.file_path ?? payload?.tool_response?.filePath;
  if (typeof file !== 'string') return null;
  const rel = relative(process.cwd(), file);
  const checked = rel.startsWith('src/') || rel.startsWith('tests/') || rel.startsWith('scripts/');
  return checked && file.endsWith('.ts') ? file : null;
}

function check(file) {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const lines = source.split('\n');
  const rel = relative(process.cwd(), file);
  const found = [];
  const at = (line, rule, what) => found.push(`${rel}:${line}  ${rule} — ${what}`);

  headerPointer(lines, at);
  sourceOrder(rel, lines, at);
  lines.forEach((line, i) => {
    inlineIf(line, i + 1, at);
    commentWidth(line, i + 1, at);
    importExtension(line, i + 1, at);
    parameterProperty(line, i + 1, at);
  });
  return found;
}

function report(file, found) {
  if (found.length === 0) process.exit(0);
  const rules = [
    'docs/conventions.md § Source order inside a file, § Inline `if`, § Comment shape',
    'CLAUDE.md § Code comments, § Toolchain constraints',
  ];
  process.stderr.write(
    `Conventions check on ${relative(process.cwd(), file)} — fix what you wrote; a line that was\n` +
      `already there, or a module the rules exempt (a data module, a bag of pure functions), stands:\n` +
      found.map((f) => `  ${f}`).join('\n') +
      `\n\nThe rules: ${rules.join('; ')}.\n`,
  );
  process.exit(2);
}

/**
 * Every `src/` file opens with a header block pointing at the doc that owns it. A test file carries
 * the same block below its imports, and an import list alone can run past 40 lines, so the window
 * is wide: over-scanning only costs a finding this tool was never the judge of.
 */
function headerPointer(lines, at) {
  const head = lines.slice(0, 120).join('\n');
  if (!head.startsWith('/**') && !head.startsWith('import') && !head.startsWith('//')) return;
  if (/docs\/[a-z-]+\.md|CLAUDE\.md/.test(head)) return;
  at(1, 'header', 'no `docs/x.md` pointer in the opening block');
}

/**
 * Public surface, subject, private support — so a `function` declaration that is not exported
 * belongs below the last exported declaration. Data modules are the documented exception, and a
 * module that is a bag of independent pure functions is another the file cannot state.
 */
function sourceOrder(rel, lines, at) {
  if (DATA_MODULE.test(rel) || rel.startsWith('tests/')) return;
  let lastExport = 0;
  const helpers = [];
  lines.forEach((line, i) => {
    if (/^export (const|let|function|async function|class|abstract class|interface|type|enum) /.test(line)) {
      lastExport = i + 1;
    }
    const helper = /^(?:async )?function ([A-Za-z0-9_]+)/.exec(line);
    if (helper) helpers.push([i + 1, helper[1]]);
  });
  for (const [line, name] of helpers.filter(([line]) => line < lastExport).slice(0, 4)) {
    at(line, 'source order', `private \`${name}\` sits above the last export (line ${lastExport})`);
  }
}

/** An inline `if` is for early outs; a multi-clause condition with a real statement gets braces. */
function inlineIf(line, number, at) {
  const head = /^\s*(?:\}\s*else\s+)?if \(/.exec(line);
  if (!head) return;
  const open = head[0].length - 1;
  const close = closingParen(line, open);
  if (close < 0) return;
  const condition = line.slice(open + 1, close);
  const statement = line.slice(close + 1).trimStart();
  if (!statement || statement.startsWith('{')) return;
  if (/^(return|continue|break|throw)\b/.test(statement)) return;
  if (!/&&|\|\|/.test(condition)) return;
  at(number, 'inline if', 'multi-clause condition carrying a statement — brace it');
}

/**
 * Index of the `)` closing the `(` at `open`, or -1 when the line never closes it. Counted rather
 * than matched: a greedy `if \((.*)\)` reads `if (a || b) return f(x);` as a condition ending at
 * `f(`, which hides the `return` an early out is exempt for.
 */
function closingParen(line, open) {
  let depth = 0;
  for (let i = open; i < line.length; i++) {
    if (line[i] === '(') depth++;
    else if (line[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Comments wrap at 100 columns; an unbreakable token (a URL, a long `code` span) is exempt. */
function commentWidth(line, number, at) {
  if (line.length <= 100 || !/^\s*(\*|\/\/)/.test(line)) return;
  if (/https?:\/\/|\S{40}/.test(line)) return;
  at(number, 'comment width', `${line.length} columns`);
}

/** Node ESM resolution: a relative import without its `.ts` does not resolve. */
function importExtension(line, number, at) {
  const m = /from '(\.[^']*)'/.exec(line);
  if (!m || TEXT_EXTS.test(m[1])) return;
  at(number, 'import', `\`${m[1]}\` needs its extension`);
}

/** Node's TS stripping has no constructor parameter properties. */
function parameterProperty(line, number, at) {
  if (!/constructor\s*\(\s*(private|public|protected|readonly)\b/.test(line)) return;
  at(number, 'toolchain', 'constructor parameter property — declare the field and assign it');
}
