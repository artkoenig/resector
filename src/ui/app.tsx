// The one screen: header band · block table · preview · prompt band · footer.
import { type ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/solid';
import { createEffect, createMemo, createSignal, on, onCleanup, Show } from 'solid-js';
import type { Verdict } from '../core/approval/approval';
import type { DockState } from './dock';
import { Dock, createDockControl } from './dock-view';
import type { Compaction } from '../gate';
import { createScreen, type ScreenOptions } from './screen';
import { around } from './format';
import { count } from '../gate/text';
import { FilterLine, Header } from './header';
import { dockMode, type KeyMode, keysOf } from './hints';
import { createKeys, modifierOf } from './keys';
import { Band, ErrorBand, errorBandLines, Footer, footerLines, PROMPT_LINES, PromptBand } from './parts';
import { Checks, Preview, ReferenceHint, type Shown } from './preview';
import { CompactionMeta, type Mode, PromptMeta, statusOf } from './prompt';
import { createSuggestions, Suggestions } from './suggestions';
import { BlockTable, createRows, isSelected, type Row, SPINNER } from './table';
import { ACCENT, BG, FAINT, KIND_COLOR, MUTED, PANEL_BG, TEXT, TONE } from './theme';

export function App(props: ScreenOptions & { onQuit: () => void }) {
  const gate = createScreen(props);
  const renderer = useRenderer();
  const size = useTerminalDimensions();
  const [mode, setMode] = createSignal<Mode>('context');
  const [draft, setDraft] = createSignal('');
  const [tick, setTick] = createSignal(0);
  const timer = setInterval(() => gate.busy() && setTick(tick() + 1), 80);
  onCleanup(() => clearInterval(timer));

  const rows = createRows(gate, tick);

  // The project's files, listed when the input opens: @path completion.
  const [files, setFiles] = createSignal<string[]>([]);
  createEffect(on(mode, m => m === 'input' && setFiles(props.project.list())));
  const suggest = createSuggestions(gate, draft, mode, files);
  const { suggestions, suggestion } = suggest;
  const editDraft = (text: string) => {
    setDraft(text);
    suggest.reset();
  };
  const choose = () => {
    const { draft: completed, run } = suggestion()!;
    if (run === null) return editDraft(completed);
    gate.submit(run);
    leaveInput();
  };
  const suggestionKeys: Record<string, () => void> = {
    up: () => suggest.move(-1),
    down: () => suggest.move(1),
    tab: () => editDraft(suggestion()!.draft),
    return: choose,
  };

  const leaveInput = () => {
    setDraft('');
    setMode('context');
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

  // Compaction: writing the instruction, then the Gate locked on the proposal.
  // A memo: `on(phase)` must fire on a phase change only, not on every update of the Compaction.
  const phase = createMemo(() => gate.compacting()?.phase);
  // The dock takes the keys; a Compaction under way keeps them.
  const docked = createDockControl(gate, { draft, editDraft, leaveInput, compacting: () => !!phase(), scrollPreview, onQuit: props.onQuit });
  // The instruction line starts empty, on `i` or when blocked with the draft of the last run.
  createEffect(on(phase, p => p === 'instruction' && editDraft(gate.compacting()!.draft)));
  createEffect(() => phase() === 'instruction' && gate.measure(draft()));
  const keyMaps = createKeys(gate, { draft, editDraft, setMode, leaveInput, startInput, scrollPreview, previewPage, onQuit: props.onQuit });

  // What a key does: the command suggestions win while any are shown; a Compaction under review locks the Gate.
  function actionOf(key: string, name: string) {
    const onSuggestion = suggestion() ? suggestionKeys[key] : undefined;
    if (onSuggestion) return onSuggestion;
    if (phase() === 'instruction') return keyMaps.instruction[key];
    if (docked.open()) return docked.keyOf(key, name);
    return mode() !== 'context' ? keyMaps.input[key] : keyMaps.gateAction(name);
  }
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
  const keyMode = (): KeyMode => (docked.open() ? dockMode(docked.state()!, docked.typingOwn()) : (phase() ?? mode()));
  const keys = () => keysOf(gate, suggestion() ? (suggestion()!.run === null ? 'complete' : 'suggest') : keyMode(), error() !== null);
  const errorLines = () => (error() === null ? 0 : errorBandLines(error()!, width()) + 1);
  // Block rows that fit: the screen less header band, filter line, column header, Template, preview band, error band, suggestions,
  // prompt band and footer. Preview and error band have a blank line above, the prompt band too. Lines never shrink, so rows cannot overlap.
  const capacity = () =>
    Math.max(1, size().height - 2 - 2 - (gate.hiding() ? 1 : 0) - (previewHeight() + 1) - errorLines() - 1 - suggestions().length - (docked.open() ? docked.lines() : PROMPT_LINES) - footerLines(footerStatus()?.text ?? '', keys(), width()));
  // The rows shown: a window around the selection.
  const visibleRows = () => around(rows(), rows().findIndex(r => isSelected(gate, r)), capacity());
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
  // Live rows stream and have no block yet.
  const blockOf = (row: Row) => (row.live ? undefined : gate.reviewed().find(b => b.id === row.id));
  const shown = (row: Row): Shown => {
    const block = blockOf(row);
    return { kind: row.kind, content: row.content, tool: block?.tool, file: block?.file, live: row.live };
  };
  const selectedRow = () => rows().find(r => isSelected(gate, r));
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
      <Show when={gate.hiding()}>
        <FilterLine gate={gate} />
      </Show>
      <BlockTable gate={gate} rows={rows()} visible={visibleRows()} width={width()} />
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
                  <ReferenceHint block={blockOf(row())} />
                  <Preview shown={shown(row())} />
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
      <Suggestions suggestions={suggestions()} chosen={suggest.chosen()} />
      <Show
        when={docked.open() && docked.state()}
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
          <Band color={ACCENT} lines={docked.lines()}>
            <Dock state={d()} width={width()} own={docked.typingOwn() ? draftInput() : undefined} />
          </Band>
        )}
      </Show>
      <Footer status={footerStatus()} hints={keys()} width={width()} />
    </box>
  );
}
