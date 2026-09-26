// Splits a bash command line into its simple commands with tree-sitter-bash (FR-22, architecture §5).
import { Language, Parser, type Node } from 'web-tree-sitter';
// Embedded in the compiled binary; the import is the file's path.
import runtime from 'web-tree-sitter/tree-sitter.wasm' with { type: 'file' };
import grammar from 'tree-sitter-bash/tree-sitter-bash.wasm' with { type: 'file' };
import type { Command, Split } from '../../core/approval/approval';

// Statements run as commands of their own; their arguments are not checked as paths.
const COMMANDS = new Set(['command', 'declaration_command', 'unset_command', 'test_command']);
// Redirects copying a file descriptor (`2>&1`, `<&-`) name no file.
const FD_COPY = new Set(['>&', '<&', '>&-', '<&-']);

const unescape = (text: string) => text.replace(/\\([\s\S])/g, '$1');

// The value of an argument as bash passes it, or null when it depends on an expansion.
function literal(node: Node): string | null {
  switch (node.type) {
    case 'word':
    case 'number':
      return unescape(node.text);
    case 'raw_string':
      return node.text.slice(1, -1);
    case 'string':
      return node.namedChildren.every(c => c?.type === 'string_content') ? node.text.slice(1, -1).replace(/\\([$`"\\])/g, '$1') : null;
    case 'concatenation': {
      const parts = node.namedChildren.map(c => literal(c!));
      return parts.includes(null) ? null : parts.join('');
    }
    default:
      return null;
  }
}

// A file redirect adds its target to the commands it applies to: written, or read (`<`) as an argument.
function redirect(node: Node, commands: Command[]) {
  const target = node.childForFieldName('destination');
  const operator = node.children.find(c => c && !c.isNamed)?.text ?? '';
  if (!target || FD_COPY.has(operator) || (operator.endsWith('&') && target.type === 'number')) return;
  const value = literal(target);
  for (const command of commands) (operator === '<' ? command.args : command.writes).push(value);
}

function collect(node: Node, out: Command[]) {
  if (COMMANDS.has(node.type)) {
    const args = node.type === 'command' ? node.childrenForFieldName('argument').map(n => literal(n!)) : [];
    out.push({ text: node.text, args, writes: [] });
  }
  if (node.type === 'redirected_statement') {
    const start = out.length;
    const body = node.childForFieldName('body');
    if (body) collect(body, out);
    const applied = out.slice(start);
    for (const r of node.childrenForFieldName('redirect')) {
      for (const file of r!.descendantsOfType('file_redirect')) redirect(file!, applied);
      collect(r!, out);
    }
    return;
  }
  for (const child of node.namedChildren) collect(child!, out);
}

export async function createSplit(): Promise<Split> {
  await Parser.init({ locateFile: () => runtime });
  const parser = new Parser();
  parser.setLanguage(await Language.load(grammar));
  return command => {
    const tree = parser.parse(command);
    if (!tree || tree.rootNode.hasError) return null;
    const out: Command[] = [];
    collect(tree.rootNode, out);
    tree.delete();
    return out;
  };
}
