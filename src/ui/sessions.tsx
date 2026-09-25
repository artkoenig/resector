// /sessions (FR-33, FR-34): full-screen table of the project's sessions with a preview of the selected one.
import { useKeyboard, useTerminalDimensions } from '@opentui/solid';
import { createSignal, For, Show } from 'solid-js';
import type { SessionStore, StoredSession } from '../adapters/store/sessions';
import { fold } from '../core/log/fold';
import { ago, cell, errorText, formatTokens, right, titleOf } from './format';

const DIM = '#808080';
const SELECTED_BG = '#3a3a3a';
const TONE = { info: '#bcbcbc', ok: '#87d787', warn: '#ffd75f', error: '#ff5f5f' };
const PREVIEW_BLOCKS = 6;
// Columns besides the title: marker, updated, profile, Context, blocks.
const FIXED_COLUMNS = 60;
const KEYS = '↑↓ select · Enter open · r rename · d delete · n new · / filter · Esc back';

type Status = { text: string; tone: keyof typeof TONE };
type Editing = { kind: 'rename'; session: StoredSession } | { kind: 'filter' };

// open/create/remove switch the current session (remove returns the status text); back returns to the Gate.
export type SessionsProps = {
  store: SessionStore;
  current: () => string;
  profiles: string[];
  windowOf: (profile: string) => number | undefined;
  open: (id: string) => Promise<void>;
  create: () => Promise<void>;
  remove: (id: string) => Promise<string>;
  rename: (id: string, title: string) => void;
  back: () => void;
};

export function Sessions(props: SessionsProps) {
  const size = useTerminalDimensions();
  const [all, setAll] = createSignal(props.store.list());
  const [filter, setFilter] = createSignal('');
  const [editing, setEditing] = createSignal<Editing | null>(null);
  const [draft, setDraft] = createSignal('');
  const [confirm, setConfirm] = createSignal<StoredSession | null>(null);
  const [status, setStatus] = createSignal<Status | null>(null);
  const list = () => all().filter(s => s.title.toLowerCase().includes(filter().toLowerCase()));
  const [selectedId, setSelectedId] = createSignal(props.current());
  const index = () => Math.max(0, list().findIndex(s => s.id === selectedId()));
  const selected = (): StoredSession | undefined => list()[index()];
  const select = (i: number) => setSelectedId(list()[Math.max(0, Math.min(list().length - 1, i))]?.id ?? '');
  const refresh = () => {
    const at = index();
    setAll(props.store.list());
    if (!list().some(s => s.id === selectedId())) select(at);
  };
  const fail = (e: unknown) => setStatus({ text: errorText(e), tone: 'error' });
  const refused = (s: StoredSession, text: string) => s.locked && (setStatus({ text, tone: 'error' }), true);

  function remove(s: StoredSession) {
    props.remove(s.id).then(text => {
      refresh();
      setStatus({ text, tone: 'info' });
    }, fail);
  }
  function finishEditing(apply: boolean) {
    const edit = editing()!;
    if (edit.kind === 'rename' && apply) {
      props.rename(edit.session.id, draft().trim());
      refresh();
    }
    if (edit.kind === 'filter' && !apply) setFilter('');
    setEditing(null);
  }

  const keys: Record<string, () => void> = {
    up: () => select(index() - 1),
    down: () => select(index() + 1),
    return: () => {
      const s = selected();
      if (s && !refused(s, `⊘ "${s.title}" is open in another resector instance`)) props.open(s.id).catch(fail);
    },
    r: () => {
      const s = selected();
      if (!s) return;
      setDraft(s.title);
      setEditing({ kind: 'rename', session: s });
    },
    d: () => {
      const s = selected();
      if (s && !refused(s, '⊘ cannot delete: open in another instance')) setConfirm(s);
    },
    n: () => void props.create().catch(fail),
    '/': () => {
      setDraft(filter());
      setEditing({ kind: 'filter' });
    },
    escape: props.back,
  };
  useKeyboard(key => {
    const pending = confirm();
    if (pending) {
      setConfirm(null);
      if (key.name === 'y') remove(pending);
      else setStatus({ text: 'delete cancelled', tone: 'info' });
    } else if (editing()) {
      if (key.name === 'return' || key.name === 'escape') finishEditing(key.name === 'return');
    } else {
      const action = keys[key.name === 'slash' ? '/' : key.name];
      if (action) key.preventDefault();
      setStatus(null);
      action?.();
    }
  });
  const onDraft = (text: string) => {
    setDraft(text);
    if (editing()?.kind === 'filter') setFilter(text);
  };

  const titleWidth = () => Math.max(8, size().width - FIXED_COLUMNS);
  const context = (s: StoredSession) => {
    const window = props.windowOf(s.profile);
    const tokens = s.tokens === null ? '–' : formatTokens(s.tokens);
    return { text: window && s.tokens !== null ? `${tokens}/${formatTokens(window)}` : tokens, warn: !!window && s.tokens! > 0.9 * window };
  };
  const preview = () => {
    const s = selected();
    if (!s) return [];
    const blocks = fold(s.events).blocks.filter(b => !b.removed);
    return blocks.slice(-PREVIEW_BLOCKS).map((b, i) => ({ n: blocks.length - Math.min(PREVIEW_BLOCKS, blocks.length) + i + 1, block: b }));
  };

  return (
    <box flexDirection="column" width="100%" height="100%">
      <text>
        <strong>{' Sessions'}</strong>
        <span style={{ fg: DIM }}>{` · ${all().length} sessions${filter() ? ` · filter "${filter()}"` : ''}`}</span>
      </text>
      <text fg={DIM}>{`     ${cell('Title', titleWidth())} ${'Updated'.padEnd(10)} ${'Profile'.padEnd(20)} ${'Context'.padEnd(14)} Blocks`}</text>
      <box flexDirection="column" flexGrow={1} overflow="hidden">
        <For each={list()}>
          {s => (
            <text bg={s.id === selected()?.id ? SELECTED_BG : undefined} fg={confirm() === s ? TONE.error : undefined}>
              <span style={{ fg: TONE.ok }}>{` ${s.id === props.current() ? '●' : ' '}`}</span>
              <span style={{ fg: TONE.error }}>{`${s.locked ? '⊘' : ' '}  `}</span>
              <span>{`${cell(s.title, titleWidth())} `}</span>
              <span style={{ fg: DIM }}>{`${ago(s.updated).padEnd(10)} `}</span>
              <span style={{ fg: props.profiles.includes(s.profile) ? undefined : TONE.error }}>
                {`${cell(props.profiles.includes(s.profile) ? s.profile : `⚠ ${s.profile}`, 20)} `}
              </span>
              <span style={{ fg: context(s).warn ? TONE.warn : undefined }}>{`${context(s).text.padEnd(14)} `}</span>
              <span>{right(String(s.blocks), 6)}</span>
            </text>
          )}
        </For>
      </box>
      <text fg={DIM}>{'─'.repeat(size().width)}</text>
      <Show when={selected()}>{(s: () => StoredSession) => <text>{` Preview · ${s().id} · last blocks`}</text>}</Show>
      <box flexDirection="column" height={PREVIEW_BLOCKS}>
        <For each={preview()}>{p => <text fg="#bcbcbc">{`   ${right(String(p.n), 3)}  ${p.block.kind.padEnd(11)}  ${cell(titleOf(p.block), titleWidth())}`}</text>}</For>
      </box>
      <Show
        when={editing()}
        fallback={
          <text fg={TONE[confirm() ? 'error' : (status()?.tone ?? 'info')]}>
            {` ${confirm() ? `Delete "${confirm()!.title}"? y / N` : (status()?.text ?? '')}`}
          </text>
        }
      >
        {(edit: () => Editing) => (
          <box flexDirection="row">
            <text fg={TONE.ok}>{edit().kind === 'rename' ? ' title > ' : ' / '}</text>
            <input focused value={draft()} onInput={onDraft} flexGrow={1} />
          </box>
        )}
      </Show>
      <text fg={DIM}>{` ${editing() ? 'Enter apply · Esc cancel' : KEYS}`}</text>
    </box>
  );
}
