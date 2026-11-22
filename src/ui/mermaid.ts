// Mermaid blocks in Markdown drawn as Unicode diagrams for the preview; a block that does not parse stays as written.
import { renderMermaidASCII } from 'beautiful-mermaid';

const BLOCK = /^```mermaid[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm;

export function drawMermaid(markdown: string): string {
  if (!markdown.includes('```mermaid')) return markdown;
  return markdown.replace(BLOCK, (block, source: string) => {
    try {
      return '```\n' + renderMermaidASCII(source, { colorMode: 'none', paddingX: 3, paddingY: 2 }) + '\n```';
    } catch {
      return block;
    }
  });
}
