// The one screen (FR-1): header band · block table · preview · prompt band · footer.
import { type MouseEvent, type ScrollBoxRenderable, TextAttributes } from '@opentui/core';
import { useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/solid';
import { createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, Show } from 'solid-js';
import { quoted, sessionRules, type Action, type Verdict } from '../core/approval/approval';
import type { Kind } from '../core/log/events';
import type { Block } from '../core/log/fold';
import { fileCompletions } from '../core/notes/files';
import { TOOL_NAMES } from '../core/toolcall/bash';
import { isRecommended, shownAnswer } from '../core/toolcall/question';
import * as dock from './dock';
import type { DockState } from './dock';
import { COMMANDS, type Compaction, createGate, type Filter, FILTERS, type Gate, type GateOptions, type Status } from './gate';
import { around, cell, count, flagsOf, formatTokens, right, thinkingLabel, titleOf } from './format';
import { Band, ErrorBand, errorBandLines, Footer, footerLines, HeaderBand, type Hint, PROMPT_LINES, PromptBand } from './parts';
import { ACCENT, BG, BORDER, FAINT, KIND_COLOR, MUTED, PANEL_BG, SELECTED_BG, TEXT, TONE } from './theme';

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
// Fixed columns around the title: marker, #, Kind, Tokens, Cache, Flags; flags beyond their column are cut, never wrapped.
const FIXED_COLUMNS = 52;
const FLAGS_WIDTH = 14;
const CACHE_COLOR: Record<string, string> = { '●': TONE.ok, '○': FAINT, '': FAINT };

type Mode = 'context' | 'input';
// A row per visible block; removed ones are struck through, unnumbered and not selectable until sent.
// dropped: a Thinking block the chat template drops (FR-48), dimmed.
// A line above the input: Tab puts `draft` into it; Enter runs `run`, or (null) completes as Tab does.
type Suggestion = { label: string; description: string; draft: string; run: string | null };
type Row = { id: number; heading?: string; n: string; kind: Kind; title: string; content: string; tokens: string; cache: string; flags: string; live: boolean; removed: boolean; dropped?: boolean };

export function App(props: GateOptions & { onQuit: () => void }) {
  const gate = createGate(props);
  const renderer = useRenderer();
  const size = useTerminalDimensions();
  const [mode, setMode] = createSignal<Mode>('context');
  const [draft, setDraft] = createSignal('');
  const [tick, setTick] = createSignal(0);
  const [suggested, setSuggested] = createSignal(0);
  const timer = setInterval(() => gate.busy() && setTick(tick() + 1), 80);
  onCleanup(() => clearInterval(timer));

  const rows = (): Row[] => {
    const split = gate.split();
    const n = (id: number) => String(gate.rows().indexOf(id) + 1);
    const tokensOf = (id: number) => split?.blocks[gate.sent().findIndex(b => b.id === id)];
    const tokens = (id: number) => (split ? formatTokens(tokensOf(id)!) : '…');
    const cache = (id: number) => ({ true: '●', false: '○', null: '' })[`${gate.warm(id)}`]!;
    const blocks = gate.context().blocks;
    // Sources of a proposal are shown as such until it is accepted or discarded (FR-15).
    const proposed = new Set(gate.compacting()?.phase === 'instruction' ? [] : gate.compacting()?.sources);
    // The running call is decided: no ? approve.
    const running = gate.running()?.call.id;
    const next = gate.nextCall()?.id;
    const done: Row[] = blocks.map(b => {
      const dropped = !b.removed && b.kind === 'Thinking' && b.content !== '' && tokensOf(b.id) === 0;
      return {
        id: b.id, kind: b.kind, title: titleOf(b, blocks), content: b.content, live: false, removed: b.removed, dropped,
        ...(b.removed ? { n: '', tokens: '', cache: '', flags: 'removed' } : { n: n(b.id), tokens: tokens(b.id), cache: cache(b.id), flags: b.id === running ? '' : flagsOf(b, next, dropped) }),
        ...(proposed.has(b.id) && { flags: '◇ proposed', removed: true }),
      };
    });
    for (const live of gate.live()) {
      const at = live.before === null ? -1 : done.findIndex(r => r.id === live.before);
      const counted = live.tokens === undefined ? SPINNER[tick() % SPINNER.length]! : formatTokens(live.tokens);
      const row = { ...live, n: n(live.id), title: titleOf({ ...live, call: running }, blocks), tokens: counted, cache: '', flags: '', live: true, removed: false };
      done.splice(at < 0 ? done.length : at, 0, row);
    }
    // The Kind Filter as the Gate applies it to selection, here also to removed rows (FR-51).
    return done.filter(r => gate.passes(r.id, r.kind));
  };

  // The project's files, listed when the input opens: @path completion (FR-27).
  const [files, setFiles] = createSignal<string[]>([]);
  createEffect(on(mode, m => m === 'input' && setFiles(props.project.list())));
  // Suggestions above the input: commands while it is a single `/word` (FR-6), the tools after `/tools `, the filter values after `/filter ` (FR-51), the policies after `/policy `, project files while an @path
  // is typed at its end (FR-27). Tab completes; Enter runs a command taking no argument, else completes too.
  const suggestions = createMemo((): Suggestion[] => {
    if (mode() !== 'input') return [];
    if (/^\/\S*$/.test(draft())) {
      return COMMANDS.filter(c => c.name.startsWith(draft())).map(c => ({
        label: `${c.name} ${c.arg}`, description: c.description, draft: c.name + (c.arg ? ' ' : ''), run: c.arg && draft() !== c.name ? null : c.name,
      }));
    }
    const tool = /^\/tools (\S*)$/.exec(draft());
    if (tool) {
      return TOOL_NAMES.filter(name => name.startsWith(tool[1]!)).map(name => ({
        label: name, description: gate.toolsOn().includes(name) ? 'on → off' : 'off → on', draft: `/tools ${name}`, run: `/tools ${name}`,
      }));
    }
    const kind = /^\/filter (\S*)$/.exec(draft());
    if (kind) {
      const off = gate.filter() ? [{ name: 'off', description: 'show all blocks' }] : [];
      return [...off, ...FILTERS.map(f => ({ name: f.name, description: f.kinds.join(' + ') }))]
        .filter(f => f.name.startsWith(kind[1]!.toLowerCase()))
        .map(f => ({ label: f.name, description: f.description, draft: `/filter ${f.name}`, run: `/filter ${f.name}` }));
    }
    const policy = /^\/policy (\S*)$/.exec(draft());
    if (policy) {
      const off = gate.policy() ? [{ name: 'off', description: 'no policy' }] : [];
      return [...off, ...gate.policyNames().map(name => ({ name, description: name === gate.policy() ? 'active' : 'switch on' }))]
        .filter(p => p.name.startsWith(policy[1]!))
        .map(p => ({ label: p.name, description: p.description, draft: `/policy ${p.name}`, run: `/policy ${p.name}` }));
    }
    const found = fileCompletions(draft(), files());
    return found ? found.paths.map(path => ({ label: path, description: '', draft: `${draft().slice(0, found.at)}${path} `, run: null })) : [];
  });
  const chosen = () => Math.min(suggested(), suggestions().length - 1);
  const suggestion = () => suggestions()[chosen()];
  const editDraft = (text: string) => {
    setDraft(text);
    setSuggested(0);
  };
  const choose = () => {
    const { draft: completed, run } = suggestion()!;
    if (run === null) return editDraft(completed);
    gate.submit(run);
    leaveInput();
  };
  const suggestionKeys: Record<string, () => void> = {
    up: () => setSuggested((suggested() + suggestions().length - 1) % suggestions().length),
    down: () => setSuggested((suggested() + 1) % suggestions().length),
    tab: () => editDraft(suggestion()!.draft),
    return: choose,
  };

  const leaveInput = () => {
    setDraft('');
    setMode('context');
  };
  const submit = () => {
    gate.submit(draft());
    leaveInput();
  };
  // `/` and `@` in the Context start a command or a file reference in the input line.
  const startInput = (text: string) => () => {
    editDraft(text);
    setMode('input');
  };
  // The preview scrolls on its own; a newly selected block starts at its top.
  let preview: ScrollBoxRenderable | undefined;
  // About a third of the screen: the kind line, at least 2 lines of content.
  const previewHeight = () => Math.max(3, Math.floor((size().height - 6) / 3));
  const scrollPreview = (lines: number) => preview?.scrollBy(lines);
  // A page keeps one line of the last: the band shows previewHeight() less the kind line.
  const previewPage = () => Math.max(1, previewHeight() - 2);
  createEffect(on(gate.selected, () => preview?.scrollTo(0)));

  const inputKeys: Record<string, () => void> = { return: submit, tab: leaveInput, escape: leaveInput };

  // Question dock (#33, #34): replaces the prompt band while the model's Question is next; its state lives in `dock`.
  // The own answer is typed while `typingOwn`.
  const [dockState, setDock] = createSignal<DockState | null>(null);
  const [typingOwn, setTypingOwn] = createSignal(false);
  createEffect(
    on(
      () => gate.asked()?.call.id,
      id => {
        setDock(id === undefined ? null : dock.openDock(gate.asked()!.questions));
        setTypingOwn(false);
        if (id !== undefined) leaveInput();
      },
    ),
  );
  // The dock takes the keys; a Compaction under way keeps them.
  const dockOpen = () => !!dockState() && !phase();
  // A step in the dock; a lone single-choice Question is sent with its first answer.
  function step(next: DockState, send = dock.direct(next)) {
    if (send) return gate.answer(dock.answers(next));
    setDock(next);
  }
  function pickRow(i: number) {
    const s = dockState()!;
    if (i === dock.choices(s).length) {
      editDraft(s.own[s.tab]!);
      return setTypingOwn(true);
    }
    if (i < dock.choices(s).length) step(dock.pick(s, i), dock.direct(s));
  }
  const dockKeys: Record<string, () => void> = {
    up: () => setDock(dock.moveRow(dockState()!, -1)),
    down: () => setDock(dock.moveRow(dockState()!, 1)),
    right: () => setDock(dock.switchTab(dockState()!, 1)),
    left: () => setDock(dock.switchTab(dockState()!, -1)),
    return: () => (dock.confirming(dockState()!) ? step(dockState()!, true) : pickRow(dockState()!.row)),
    r: () => step(dock.recommend(dockState()!)),
    'shift+up': () => scrollPreview(-1),
    'shift+down': () => scrollPreview(1),
    escape: gate.decline,
    q: props.onQuit,
  };
  function closeOwn() {
    setTypingOwn(false);
    editDraft('');
  }
  const ownKeys: Record<string, () => void> = {
    return: () => {
      const s = dockState()!;
      const text = draft().trim();
      if (!text && !s.questions[s.tab]!.multiple) return;
      closeOwn();
      step(dock.writeOwn(s, text), dock.direct(s));
    },
    escape: closeOwn,
  };
  // Lines of the dock's band, which takes the prompt band's place: the dock, then a meta line.
  const dockLines = () => dockHeight(dockState()!) + 1;
  // Compaction (FR-13, FR-15): writing the instruction, then the Gate locked on the proposal.
  // A memo: `on(phase)` must fire on a phase change only, not on every update of the Compaction.
  const phase = createMemo(() => gate.compacting()?.phase);
  // The instruction line starts empty, on `i` or when blocked with the draft of the last run.
  createEffect(on(phase, p => p === 'instruction' && editDraft(gate.compacting()!.draft)));
  createEffect(() => phase() === 'instruction' && gate.measure(draft()));
  const instructionKeys: Record<string, () => void> = {
    return: () => gate.runCompaction(draft()),
    tab: () => draft() || editDraft(gate.defaultInstruction()),
    escape: () => {
      gate.leaveInstruction();
      editDraft('');
    },
  };
  const reviewKeys: Record<string, () => void> = {
    return: gate.acceptCompaction,
    x: gate.discardCompaction,
    escape: gate.discardCompaction,
    i: gate.refine,
    e: gate.editProposal,
    'shift+up': () => scrollPreview(-1),
    'shift+down': () => scrollPreview(1),
    pageup: () => scrollPreview(-previewPage()),
    pagedown: () => scrollPreview(previewPage()),
    q: props.onQuit,
  };
  const contextKeys: Record<string, () => void> = {
    tab: () => setMode('input'),
    '/': startInput('/'),
    '@': startInput('@'),
    'shift+@': startInput('@'),
    return: () => void gate.send(),
    up: () => gate.select(-1),
    down: () => gate.select(1),
    'alt+up': () => gate.move(-1),
    'alt+down': () => gate.move(1),
    'shift+up': () => scrollPreview(-1),
    'shift+down': () => scrollPreview(1),
    pageup: () => scrollPreview(-previewPage()),
    pagedown: () => scrollPreview(previewPage()),
    y: gate.approve,
    a: gate.allowForSession,
    n: gate.reject,
    d: gate.remove,
    u: gate.undo,
    e: gate.edit,
    space: gate.toggleMark,
    c: gate.startCompaction,
    t: gate.cycleThinking,
    escape: () => (gate.status()?.tone === 'error' ? gate.dismiss() : gate.clearMarks()),
    q: props.onQuit,
  };
  // The key pressed last in the Context: only the same key again confirms (FR-9).
  let lastKey = '';
  // A key in the Context. Streaming or running: only looking around (select, scroll, quit); Esc aborts, the Context stays as sent.
  function contextAction(name: string) {
    if (name !== lastKey) gate.cancelConfirm();
    lastKey = name;
    if (gate.marked().size && SINGLE_KEYS.has(name)) return undefined;
    if (!gate.busy()) return contextKeys[name];
    return name === 'escape' ? gate.abort : BUSY_KEYS.has(name) ? contextKeys[name] : undefined;
  }
  // What a key does: the command suggestions win while any are shown; a Compaction under review locks the Gate.
  function actionOf(key: string, name: string) {
    const onSuggestion = suggestion() ? suggestionKeys[key] : undefined;
    if (onSuggestion) return onSuggestion;
    if (phase() === 'instruction') return instructionKeys[key];
    if (dockOpen()) return typingOwn() ? ownKeys[key] : dockKeys[name];
    return mode() !== 'context' ? inputKeys[key] : gateAction(name);
  }
  const gateAction = (name: string) => (phase() === 'review' ? reviewKeys[name] : contextAction(name));
  useKeyboard(key => {
    const action = actionOf(key.name, modifierOf(key) + key.name);
    // Handled here only: `/`, `@`, `i` must not also type into the input they focus, Tab not reach it.
    if (action) key.preventDefault();
    action?.();
  });

  const idle = () => {
    if (!phase()) return { text: 'Tab to write · Enter sends the Context', fg: MUTED };
    const review = gate.review();
    if (review) return { text: `◇ ${review.tokens}`, fg: review.over ? TONE.error : TEXT };
    return { text: `◇ proposal for ${count(gate.compacting()!.sources.length, 'block')} – the Context is locked until accepted or discarded`, fg: MUTED };
  };
  const width = () => size().width;
  const status = () => statusOf(gate, SPINNER[tick() % SPINNER.length]!);
  // An error has its own band; the footer then shows only the hints.
  const error = () => (status()?.tone === 'error' ? status()!.text : null);
  const footerStatus = () => (error() === null ? status() : null);
  const keyMode = (): KeyMode => (dockOpen() ? dockMode(dockState()!, typingOwn()) : (phase() ?? mode()));
  const keys = () => keysOf(gate, suggestion() ? (suggestion()!.run === null ? 'complete' : 'suggest') : keyMode(), error() !== null);
  const errorLines = () => (error() === null ? 0 : errorBandLines(error()!, width()) + 1);
  // Block rows that fit: the screen less header band, filter line, column header, Template, preview band, error band, suggestions,
  // prompt band and footer. Preview and error band have a blank line above, the prompt band too. Lines never shrink, so rows cannot overlap.
  const capacity = () =>
    Math.max(1, size().height - 2 - 2 - (gate.filter() ? 1 : 0) - (previewHeight() + 1) - errorLines() - 1 - suggestions().length - (dockOpen() ? dockLines() : PROMPT_LINES) - footerLines(footerStatus()?.text ?? '', keys(), width()));
  // The rows shown: a window around the selection.
  const visibleRows = () => around(rows(), rows().findIndex(r => r.id === gate.selected() && !r.removed), capacity());
  // The wheel over the block table moves the selection, like ↑↓ (also while busy).
  const wheel = (event: MouseEvent) => {
    const step = WHEEL[event.scroll?.direction ?? ''];
    if (step) gate.select(step);
  };
  const titleWidth = () => Math.max(8, width() - FIXED_COLUMNS);
  // The one input: the draft, the Compaction instruction or the own answer in the dock.
  const draftInput = (placeholder?: string) => (
    <input
      focused
      value={draft()}
      placeholder={placeholder}
      placeholderColor={FAINT}
      onInput={editDraft}
      flexGrow={1}
      backgroundColor={PANEL_BG}
      focusedBackgroundColor={PANEL_BG}
      textColor={TEXT}
      focusedTextColor={TEXT}
      cursorColor={ACCENT}
    />
  );
  const selectedRow = () => rows().find(r => r.id === gate.selected() && !r.removed);
  const isSelected = (row: Row) => !row.removed && row.id === gate.selected();
  // Copy on select: the text selected with the mouse goes to the clipboard on release.
  const copySelection = () => {
    const text = renderer.getSelection()?.getSelectedText();
    if (!text) return;
    gate.copy(text);
    renderer.clearSelection();
  };

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={BG} onMouseUp={copySelection}>
      <Header gate={gate} width={width()} />
      <Show when={gate.filter()}>{(filter: () => Filter) => <FilterLine gate={gate} filter={filter()} />}</Show>
      <text fg={MUTED} flexShrink={0}>{`     #  ${'Type'.padEnd(11)}  ${cell('Content', titleWidth())}  Tokens  Cache  Flags`}</text>
      <box flexDirection="column" flexGrow={1} overflow="hidden" onMouseScroll={wheel}>
        <For each={visibleRows()}>
          {row => {
            const fg = () => columnFg(row, isSelected(row));
            return (
              <text flexShrink={0} bg={isSelected(row) ? SELECTED_BG : undefined} fg={fg().text}>
                <span style={{ fg: ACCENT }}>{`${isSelected(row) ? '┃' : ' '} ${gate.marked().has(row.id) ? '●' : ' '}`}</span>
                <span style={{ fg: fg().muted }}>{`${right(row.n, 3)}  `}</span>
                <span style={{ fg: fg().kind, strikethrough: row.removed }}>{row.kind.padEnd(11)}</span>
                <span>{'  '}</span>
                <span style={{ fg: fg().muted, strikethrough: row.removed, italic: row.kind === 'Thinking' }}>{cell(row.title, titleWidth())}</span>
                <span>{'  '}</span>
                <span style={{ fg: fg().tokens }}>{right(row.tokens, 6)}</span>
                <span style={{ fg: CACHE_COLOR[row.cache] }}>{`    ${row.cache.padEnd(1)}    `}</span>
                <span style={{ fg: fg().flags }}>{cell(row.flags, FLAGS_WIDTH).trimEnd()}</span>
              </text>
            );
          }}
        </For>
        <Show when={gate.filter() && rows().every(r => r.removed)}>
          <text fg={MUTED} flexShrink={0}>{`        no ${gate.filter()!.name} blocks`}</text>
        </Show>
        <text fg={MUTED} flexShrink={0}>
          {`        ${'Template'.padEnd(11)}  ${cell('BOS · generation prompt', titleWidth())}  ${right(gate.split() ? String(gate.split()!.template) : '…', 6)}`}
        </text>
      </box>
      <box flexDirection="column" height={previewHeight() + 1} flexShrink={0}>
        <Show when={selectedRow()}>
          {(row: () => Row) => (
            <>
              <text flexShrink={0}> </text>
              <Band color={KIND_COLOR[row().kind]} lines={previewHeight()}>
                <text flexShrink={0}>
                  <strong>
                    <span style={{ fg: KIND_COLOR[row().kind] }}>{row().kind}</span>
                  </strong>
                  <span style={{ fg: MUTED }}>{`  #${row().n}${row().heading ? ` · ${row().heading}` : row().live ? '' : ` · ${row().tokens} tokens`}`}</span>
                </text>
                <scrollbox ref={preview} flexGrow={1}>
                  <Show when={row().dropped}>
                    <text fg={TONE.warn}>✂ dropped by the chat template – sent, but 0 tokens reach the model</text>
                  </Show>
                  <Show when={!row().live && !gate.running() && gate.nextCall()?.id === row().id && gate.verdict(gate.nextCall()!)}>
                    {(verdict: () => Verdict) => <Checks verdict={verdict()} />}
                  </Show>
                  <ReferenceHint block={row().live ? undefined : gate.context().blocks.find(b => b.id === row().id)} />
                  {/* Two elements: opentui keeps italic once set on a span. */}
                  <Show when={row().kind === 'Thinking'} fallback={<text fg={MUTED}>{row().content}</text>}>
                    <text fg={MUTED} attributes={TextAttributes.ITALIC}>
                      {row().content}
                    </text>
                  </Show>
                </scrollbox>
              </Band>
            </>
          )}
        </Show>
      </box>
      <Show when={error()}>
        {(text: () => string) => (
          <>
            <text flexShrink={0}> </text>
            <ErrorBand text={text()} width={width()} />
          </>
        )}
      </Show>
      <text flexShrink={0}> </text>
      <For each={suggestions()}>
        {(s, i) => (
          <text flexShrink={0} bg={i() === chosen() ? SELECTED_BG : undefined}>
            <span style={{ fg: i() === chosen() ? ACCENT : TEXT }}>{`  ${s.label.padEnd(22)} `}</span>
            <span style={{ fg: MUTED }}>{s.description}</span>
          </text>
        )}
      </For>
      <Show
        when={dockOpen() && dockState()}
        fallback={
          <PromptBand
            meta={
              <Show when={gate.compacting()} fallback={<PromptMeta mode={mode()} />}>
                {(c: () => Compaction) => <CompactionMeta gate={gate} compaction={c()} />}
              </Show>
            }
          >
            <Show when={mode() !== 'context' || phase() === 'instruction'} fallback={<text fg={idle().fg}>{idle().text}</text>}>
              <box flexDirection="row" flexGrow={1}>
                <Show when={phase() === 'instruction'}>
                  <text fg={ACCENT} flexShrink={0}>{'instruction > '}</text>
                </Show>
                {draftInput(phase() === 'instruction' ? gate.defaultInstruction() : undefined)}
              </box>
            </Show>
          </PromptBand>
        }
      >
        {(d: () => DockState) => (
          <Band color={ACCENT} lines={dockLines()}>
            <Dock state={d()} width={width()} own={typingOwn() ? draftInput() : undefined} />
          </Band>
        )}
      </Show>
      <Footer status={footerStatus()} hints={keys()} width={width()} />
    </box>
  );
}

const ACTION_COLOR: Record<Action, string> = { allow: TONE.ok, ask: TONE.warn, deny: TONE.error };
// Why the rules ask for the pending call: each sub-command with its decision and reason (FR-22), then what `a`
// would allow for the session, before anything is saved (FR-23).
function Checks(props: { verdict: Verdict }) {
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

// An unread @path reference in the preview: when it is read, or why it cannot be (FR-27).
function ReferenceHint(props: { block: Block | undefined }) {
  return (
    <Show when={props.block?.unread}>
      <text fg={props.block!.missing ? TONE.warn : MUTED}>{props.block!.missing ?? '@path reference – read at send, a snapshot from then on · e opens the file'}</text>
    </Show>
  );
}

// The model's Question (#33, #34): with several questions or a `multiple` one a tab bar first, then the current
// question with its options, the Recommended ones first and marked, then the own answer; or on Confirm the answers.
// `own`: the input while the own answer is typed; it takes the own answer's row.
function Dock(props: { state: DockState; width: number; own?: JSX.Element }) {
  return (
    <>
      <Show when={!dock.direct(props.state)} fallback={<QuestionTab state={props.state} width={props.width} own={props.own} title />}>
        <TabBar state={props.state} />
        <Show when={!dock.confirming(props.state)} fallback={<ConfirmTab state={props.state} />}>
          <QuestionTab state={props.state} width={props.width} own={props.own} />
        </Show>
      </Show>
      <text flexShrink={0}>
        <span style={{ fg: KIND_COLOR['Tool Result'] }}>Tool Result</span>
        <span style={{ fg: MUTED }}>  the answer, written by you</span>
      </text>
    </>
  );
}
// Dock lines without the meta line: the tab bar, then the question line, its options and the own answer, or on Confirm the answers and a hint.
function dockHeight(s: DockState): number {
  if (dock.direct(s)) return dock.choices(s).length + 2;
  return 1 + (dock.confirming(s) ? s.questions.length + 1 : dock.choices(s).length + 2);
}
function TabBar(props: { state: DockState }) {
  const tab = (i: number, label: string) => (
    <span style={{ fg: i === props.state.tab ? ACCENT : MUTED, bg: i === props.state.tab ? SELECTED_BG : undefined }}>{` ${label} `}</span>
  );
  return (
    <text flexShrink={0}>
      <span> </span>
      <For each={props.state.questions}>{(q, i) => tab(i(), `${dock.answered(props.state, i()) ? '✓' : '·'} ${q.header}`)}</For>
      {tab(props.state.questions.length, 'Confirm')}
    </text>
  );
}
function QuestionTab(props: { state: DockState; width: number; own?: JSX.Element; title?: boolean }) {
  const q = () => dock.current(props.state)!;
  const options = () => dock.choices(props.state);
  const row = () => props.state.row;
  const picks = () => props.state.picks[props.state.tab]!;
  const own = () => props.state.own[props.state.tab]!;
  const labelWidth = () => Math.max(...options().map(o => o.label.length));
  const box = (on: boolean) => (q().multiple ? (on ? '[✓] ' : '[ ] ') : '');
  const marker = (i: number) => `  ${i === row() ? '›' : ' '} `;
  const title = () => (props.title ? `${q().header} · ` : '');
  return (
    <>
      <text flexShrink={0}>
        <span style={{ fg: ACCENT }}>{`  ${title()}`}</span>
        <span style={{ fg: TEXT }}>{cell(q().question, Math.max(8, props.width - title().length - 3)).trimEnd()}</span>
      </text>
      <For each={options()}>
        {(o, i) => (
          <text flexShrink={0} bg={i() === row() ? SELECTED_BG : undefined}>
            <span style={{ fg: i() === row() ? ACCENT : TEXT }}>{`${marker(i())}${box(picks().includes(o.label))}${o.label.padEnd(labelWidth())} `}</span>
            <span style={{ fg: TONE.ok }}>{isRecommended(q(), o) ? 'recommended ' : ''}</span>
            <span style={{ fg: MUTED }}>{o.description}</span>
          </text>
        )}
      </For>
      <Show
        when={props.own}
        fallback={
          <text flexShrink={0} bg={row() === options().length ? SELECTED_BG : undefined} fg={row() === options().length ? ACCENT : MUTED}>
            {`${marker(options().length)}${box(!!own())}own answer${own() ? `: ${own()}` : ''}`}
          </text>
        }
      >
        <box flexDirection="row" flexShrink={0}>
          <text fg={ACCENT} flexShrink={0}>{`${marker(options().length)}answer > `}</text>
          {props.own}
        </box>
      </Show>
    </>
  );
}
function ConfirmTab(props: { state: DockState }) {
  const width = () => Math.max(...props.state.questions.map(q => q.header.length));
  return (
    <>
      <For each={dock.answers(props.state)}>
        {(a, i) => (
          <text flexShrink={0}>
            <span style={{ fg: TEXT }}>{`  ${props.state.questions[i()]!.header.padEnd(width())}  `}</span>
            <span style={{ fg: a.length ? TEXT : MUTED }}>{shownAnswer(a)}</span>
          </text>
        )}
      </For>
      <text flexShrink={0} fg={MUTED}>
        {'  enter sends the answers · r fills the unanswered with the recommendation'}
      </text>
    </>
  );
}

// Meta line of the prompt band: what Enter does with the draft.
function PromptMeta(props: { mode: Mode }) {
  return (
    <Show when={props.mode !== 'context'}>
      <span style={{ fg: KIND_COLOR.User }}>User</span>
      <span style={{ fg: MUTED }}>  adds a block and sends the Context · @path[:a-b] adds a file</span>
    </Show>
  );
}

// Compaction: the header while writing the instruction (FR-13), the proposal's effect while it is reviewed (FR-15).
function CompactionMeta(props: { gate: Gate; compaction: Compaction }) {
  const c = () => props.compaction;
  const tokens = (t: number | null) => (t === null ? '…' : formatTokens(t));
  const fits = () => c().request === null || c().request! < c().backend.window;
  const request = () =>
    fits() ? `request ${tokens(c().request)} / ${formatTokens(c().backend.window)}` : `request ${tokens(c().request)} ≥ window ${formatTokens(c().backend.window)} – does not fit`;
  const review = () => props.gate.review();
  return (
    <Show
      when={c().phase === 'instruction'}
      fallback={
        <span style={{ fg: review()?.cold ? TONE.warn : MUTED }}>{c().phase === 'running' ? `compacting with ${c().profile} …` : (review()?.cache ?? 'counting …')}</span>
      }
    >
      <span style={{ fg: ACCENT }}>{`◇ Compact ${count(c().sources.length, 'block')} (${tokens(props.gate.sourceTokens())} tok)`}</span>
      <span style={{ fg: MUTED }}>{` · ${c().profile} · `}</span>
      <span style={{ fg: fits() ? MUTED : TONE.error }}>{request()}</span>
    </Show>
  );
}

function Header(props: { gate: Gate; width: number }) {
  const total = () => props.gate.split()?.total ?? 0;
  const used = () => (props.gate.split() ? formatTokens(total()) : '…');
  const budget = () => props.gate.budget();
  // FR-2: ±X drift of an inexact tokenizer, dimmed; above the window red `over by X`.
  const window = () => ` / ${formatTokens(props.gate.window())}`;
  const drift = () => {
    const label = budget()?.driftLabel;
    return label ? ` ${label}` : '';
  };
  const over = () => {
    const tokens = budget()?.over;
    return tokens ? ` over by ${formatTokens(tokens)}` : '';
  };
  const tone = () => ({ ok: undefined, warn: TONE.warn, over: TONE.error })[budget()?.tone ?? 'ok'];
  const profile = () => props.gate.profile();
  // The active Context Policy follows the thinking mode (ADR 0001).
  const thinking = () => ` · thinking ${thinkingLabel(props.gate.thinking())}${props.gate.policy() ? ` · policy ${props.gate.policy()}` : ''}`;
  return (
    <HeaderBand
      width={props.width}
      title={<span style={{ fg: MUTED }}>{profile() + thinking()}</span>}
      titleWidth={profile().length + thinking().length}
      right={
        <>
          <span style={{ fg: tone() ?? TEXT }}>{used()}</span>
          <span style={{ fg: tone() ?? MUTED }}>{window()}</span>
          <span style={{ fg: MUTED }}>{drift()}</span>
          <span style={{ fg: TONE.error }}>{over()}</span>
        </>
      }
      rightWidth={used().length + window().length + drift().length + over().length}
      below={
        <text>
          <span>{'  '}</span>
          <For each={contextBar(props.gate, Math.max(0, props.width - 4))}>{c => <span style={{ fg: c.color }}>{c.char}</span>}</For>
        </text>
      }
    />
  );
}

// The Kind Filter below the header: its share of the blocks and tokens sent; removed ones are not (FR-51).
function FilterLine(props: { gate: Gate; filter: Filter }) {
  const share = () => props.gate.filterShare();
  const tokens = () => (share().total === null ? '…' : `${formatTokens(share().tokens!)}/${formatTokens(share().total!)}`);
  return (
    <text flexShrink={0}>
      <span style={{ fg: ACCENT }}>{`  filter: ${props.filter.name}`}</span>
      <span style={{ fg: MUTED }}>{` · ${share().blocks}/${share().all} blocks · ${tokens()} tokens`}</span>
    </text>
  );
}

// FR-2: one segment per block in Context order (plus Template), proportional to tokens; free space in the border colour.
// Over the window the bar is scaled to the Context and marks the window edge.
// Half cells: thicker than a line, lighter than a solid strip.
const BAR = '▀';
const EDGE = '│';
function contextBar(gate: Gate, width: number): { char: string; color: string }[] {
  const split = gate.split();
  const cells = Array.from({ length: width }, () => ({ char: BAR, color: BORDER }));
  if (!split) return cells;
  const scale = Math.max(split.total, gate.window());
  const segments = [
    ...gate.sent().map((b, i) => ({ tokens: split.blocks[i]!, color: b.id === gate.selected() ? TEXT : KIND_COLOR[b.kind], selected: b.id === gate.selected() })),
    { tokens: split.template, color: FAINT, selected: false },
  ];
  let sum = 0;
  let filled = 0;
  for (const s of segments) {
    const from = Math.max(filled, Math.round((sum / scale) * width));
    sum += s.tokens;
    const to = Math.max(Math.round((sum / scale) * width), s.selected ? from + 1 : 0);
    for (let x = from; x < Math.min(to, width); x++) cells[x] = { char: BAR, color: s.color };
    filled = Math.max(filled, to);
  }
  const edge = Math.round((gate.window() / scale) * width);
  if (split.total > gate.window() && edge < width) cells[edge] = { char: EDGE, color: TONE.error };
  return cells;
}

// Keys acting on the selected block only: off while blocks are marked.
const SINGLE_KEYS = new Set(['alt+up', 'alt+down', 'y', 'a', 'n', 'p', 'e']);
const BUSY_KEYS = new Set(['up', 'down', 'shift+up', 'shift+down', 'pageup', 'pagedown', 'q']);
const WHEEL: Record<string, number> = { up: -1, down: 1 };

const modifierOf = (key: { option?: boolean; meta: boolean; shift: boolean }) =>
  key.option || key.meta ? 'alt+' : key.shift ? 'shift+' : '';

const LOOK_KEYS: Hint[] = [['q', 'quit']];
// With marks only what acts on all marked blocks.
const MARKED_KEYS: Hint[] = [['d', 'remove'], ['c', 'compact'], ['space', 'mark'], ['esc', 'unmark'], ['q', 'quit']];
const MOVE: Hint = ['⌥↑↓', 'move'];
const KEYS: Hint[] = [MOVE, ['e', 'edit'], ['d', 'remove'], ['space', 'mark'], ['c', 'compact'], ['t', 'thinking'], ['u', 'undo'], ['q', 'quit']];

// Colours of a row: a removed one is muted throughout, one the chat template drops all but its flags.
const rowFg = (row: Row) =>
  row.removed || row.dropped
    ? { text: MUTED, kind: MUTED, flags: row.dropped ? TONE.warn : MUTED }
    : { text: TEXT, kind: KIND_COLOR[row.kind], flags: TONE.warn };
// A row's column colours: # and Content muted unless selected; Tokens yellow while live (not yet in the Context).
const columnFg = (row: Row, selected: boolean) => {
  const muted = selected ? TEXT : MUTED;
  return { ...rowFg(row), muted, tokens: row.live && !row.removed ? TONE.warn : muted };
};

// Status line: a running command, the streaming answer (both with the row's spinner), else the last action.
function statusOf(gate: Gate, spin: string): Status | null {
  const r = gate.running();
  if (r) return { text: `${spin} running: ${cell(titleOf(r.call), 50).trimEnd()} · ${Math.round((Date.now() - r.started) / 1000)}s / ${r.timeout}s`, tone: 'warn' };
  if (gate.compacting()?.phase === 'running') return { text: `${spin} compacting with ${gate.compacting()!.profile}`, tone: 'warn' };
  const s = gate.streaming();
  if (!s) return gate.status();
  return { text: `${spin} model is ${s.thinking && !s.text ? 'thinking' : 'responding'}`, tone: 'warn' };
}

// Key hints right of the status; they stay visible. An error band adds how to dismiss it.
type KeyMode = Mode | 'suggest' | 'complete' | 'question' | 'questions' | 'answer' | Compaction['phase'];
// The dock's keys: tabs only with several questions or a `multiple` one.
const dockMode = (s: DockState, typingOwn: boolean): KeyMode => (typingOwn ? 'answer' : dock.direct(s) ? 'question' : 'questions');
function keysOf(gate: Gate, mode: KeyMode, error: boolean): Hint[] {
  const keys = modeKeys(gate, mode);
  return error && mode === 'context' ? [...keys.slice(0, -1), ['esc', 'dismiss'], keys.at(-1)!] : keys;
}
// Modes with their own keys; streaming or running starts only from the Context.
const MODE_KEYS: Partial<Record<KeyMode, Hint[]>> = {
  running: [['esc', 'abort'], ...LOOK_KEYS],
  review: [['enter', 'accept'], ['x', 'discard'], ['i', 'instruction'], ['e', 'edit'], ...LOOK_KEYS],
  instruction: [['enter', 'compact'], ['tab', 'default'], ['esc', 'back']],
  suggest: [['↑↓', 'choose'], ['tab', 'complete'], ['enter', 'run'], ['esc', 'back']],
  complete: [['↑↓', 'choose'], ['tab/enter', 'complete'], ['esc', 'back']],
  input: [['enter', 'send'], ['tab/esc', 'back']],
  question: [['↑↓', 'choose'], ['enter', 'pick'], ['esc', 'decline'], ['q', 'quit']],
  questions: [['↑↓', 'choose'], ['enter', 'pick'], ['←→', 'question'], ['r', 'recommended'], ['esc', 'decline'], ['q', 'quit']],
  answer: [['enter', 'answer'], ['esc', 'back']],
};
function modeKeys(gate: Gate, mode: KeyMode): Hint[] {
  const own = MODE_KEYS[mode];
  if (own) return own;
  if (gate.running()) return [['esc', 'kill'], ...LOOK_KEYS];
  if (gate.streaming()) return [['esc', 'abort'], ...LOOK_KEYS];
  if (gate.marked().size) return MARKED_KEYS;
  // No move under a Kind Filter (FR-51).
  const keys = gate.filter() ? KEYS.filter(k => k !== MOVE) : KEYS;
  return gate.selectedBlock()?.pending ? [['y', 'run once'], ['a', 'allow for session'], ['n', 'reject'], ...keys] : keys;
}
