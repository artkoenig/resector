// The preview's content: Markdown rendered, file snapshots and bash commands highlighted by OpenTUI's tree-sitter.
import { addDefaultParsers, pathToFiletype, SyntaxStyle, TextAttributes, type CliRenderer } from '@opentui/core';
import { useRenderer } from '@opentui/solid';
import { For, Match, Show, Switch } from 'solid-js';
import grammar from 'tree-sitter-bash/tree-sitter-bash.wasm' with { type: 'file' };
import highlights from 'tree-sitter-bash/queries/highlights.scm' with { type: 'file' };
import { quoted, sessionRules, type Action, type Verdict } from '../core/approval/approval';
import type { Kind, Tool } from '../core/log/events';
import type { Reviewed } from '../gate/review';
import { parseReference } from '../core/notes/files';
import { drawMermaid } from './mermaid';
import { ACCENT, BORDER, FAINT, KIND_COLOR, MUTED, TEXT, TONE } from './theme';

// OpenTUI ships JavaScript, TypeScript, Markdown and Zig; bash comes from the grammar the approval already uses.
// Other file types show unstyled.
addDefaultParsers([{ filetype: 'bash', wasm: grammar, queries: { highlights: [highlights] } }]);

const STRING = '#7fd88f';
const NUMBER = '#f5a742';
const KEYWORD = '#9d7cd8';
const FUNCTION = '#5c9cf5';
const TYPE = '#e5c07b';

// Created on first use, one per renderer: a SyntaxStyle lives in its renderer's native context.
const styles = new WeakMap<CliRenderer, SyntaxStyle>();
const syntax = (renderer: CliRenderer) => {
  const known = styles.get(renderer);
  if (known) return known;
  const style = createStyle(renderer);
  styles.set(renderer, style);
  return style;
};
const createStyle = (renderer: CliRenderer) =>
  SyntaxStyle.fromStyles({
    default: { fg: MUTED },
    conceal: { fg: FAINT },
    'markup.heading': { fg: ACCENT, bold: true },
    'markup.strong': { fg: TEXT, bold: true },
    'markup.italic': { fg: TEXT, italic: true },
    'markup.strikethrough': { fg: MUTED, dim: true },
    'markup.raw': { fg: KIND_COLOR.Assistant },
    'markup.link': { fg: FUNCTION, underline: true },
    'markup.link.label': { fg: FUNCTION },
    'markup.link.url': { fg: MUTED, underline: true },
    'markup.list': { fg: ACCENT },
    'markup.quote': { fg: MUTED, italic: true },
    comment: { fg: MUTED, italic: true },
    string: { fg: STRING },
    'string.escape': { fg: NUMBER },
    'string.regexp': { fg: NUMBER },
    number: { fg: NUMBER },
    boolean: { fg: NUMBER },
    constant: { fg: NUMBER },
    keyword: { fg: KEYWORD },
    operator: { fg: TONE.error },
    function: { fg: FUNCTION },
    'function.builtin': { fg: FUNCTION },
    constructor: { fg: TYPE },
    type: { fg: TYPE },
    property: { fg: KIND_COLOR.Assistant },
    'variable.member': { fg: KIND_COLOR.Assistant },
    'variable.builtin': { fg: TONE.error },
    'variable.parameter': { fg: MUTED },
    label: { fg: TYPE },
    'punctuation.special': { fg: ACCENT },
  }, renderer.nativeScene);

// What the preview shows of a block; file: a Note's source file, live: still streaming.
export type Shown = { kind: Kind; content: string; tool?: Tool; file?: string; live: boolean };

// A file Note starts with its `[reference]` line; a range is numbered line by line and stays plain.
function fileContent(file: string, content: string): { head: string; body: string; filetype?: string } {
  const head = `[${file}]`;
  const body = content.startsWith(`${head}\n`) ? content.slice(head.length + 1) : content;
  const { path, from } = parseReference(file);
  return { head, body, filetype: from === null ? pathToFiletype(path) : undefined };
}

export function Preview(props: { shown: Shown }) {
  const s = () => props.shown;
  const file = () => (s().file ? fileContent(s().file!, s().content) : undefined);
  return (
    <Switch fallback={<text fg={MUTED}>{s().content}</text>}>
      {/* Two elements: opentui keeps italic once set on a span. */}
      <Match when={s().kind === 'Thinking'}>
        <text fg={MUTED} attributes={TextAttributes.ITALIC}>
          {s().content}
        </text>
      </Match>
      {/* The image itself goes to the model only; the terminal shows where it comes from. */}
      <Match when={s().kind === 'Image'}>
        <text fg={MUTED}>{`${s().content}\nimage · sent as it is`}</text>
      </Match>
      <Match when={file()}>
        {(f: () => { head: string; body: string; filetype?: string }) => (
          <box flexDirection="column">
            <text fg={MUTED}>{f().head}</text>
            <Content content={f().body} filetype={f().filetype} live={false} />
          </box>
        )}
      </Match>
      <Match when={s().kind === 'Tool Call' && (s().tool ?? 'bash') === 'bash'}>
        <Content content={s().content} filetype="bash" live={s().live} />
      </Match>
      <Match when={s().kind === 'User' || s().kind === 'Assistant' || s().kind === 'Note' || s().kind === 'System'}>
        <Content content={s().content} filetype="markdown" live={s().live} />
      </Match>
    </Switch>
  );
}

// While live, plain text: re-parsing and highlighting on every token makes the preview flicker.
function Content(props: { content: string; filetype: string | undefined; live: boolean }) {
  const renderer = useRenderer();
  return (
    <Switch fallback={<text fg={MUTED}>{props.content}</text>}>
      <Match when={!props.live && props.filetype === 'markdown'}>
        <markdown content={drawMermaid(props.content)} syntaxStyle={syntax(renderer)} fg={MUTED} conceal tableOptions={{ widthMode: 'content', borderColor: BORDER }} />
      </Match>
      <Match when={!props.live && props.filetype}>
        {(ft: () => string) => <code content={props.content} filetype={ft()} syntaxStyle={syntax(renderer)} fg={MUTED} wrapMode="word" />}
      </Match>
    </Switch>
  );
}

const ACTION_COLOR: Record<Action, string> = { allow: TONE.ok, ask: TONE.warn, deny: TONE.error };
// Why the rules ask for the pending call: each sub-command with its decision and reason, then what `a`
// would allow for the session, before anything is saved.
export function Checks(props: { verdict: Verdict }) {
  const session = () => {
    const found = sessionRules(props.verdict);
    return 'error' in found ? found.error : `a allows ${quoted(found.patterns)} for this session`;
  };
  return (
    <>
      <For each={props.verdict.checks}>
        {c => (
          <text>
            <span style={{ fg: ACTION_COLOR[c.action] }}>{c.action.padEnd(6)}</span>
            <span style={{ fg: TEXT }}>{c.text.replace(/\s+/g, ' ')}</span>
            <span style={{ fg: MUTED }}>{`  ${c.why}`}</span>
          </text>
        )}
      </For>
      <text fg={MUTED}>{session()}</text>
      <text> </text>
    </>
  );
}

// An unread @path reference in the preview: when it is read, or why it cannot be.
export function ReferenceHint(props: { block: Reviewed | undefined }) {
  return (
    <Show when={props.block?.unread}>
      <text fg={props.block!.missing ? TONE.warn : MUTED}>{props.block!.missing ?? '@path reference – read at send, a snapshot from then on · e opens the file'}</text>
    </Show>
  );
}
