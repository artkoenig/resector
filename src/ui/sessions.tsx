// /sessions: full-screen table of the project's sessions with a preview of the selected one.
import { useKeyboard, useTerminalDimensions } from '@opentui/solid';
import { createSignal, For, Show } from 'solid-js';
import type { SessionStore, StoredSession } from '../adapters/store/sessions';
import { fold } from '../core/log/fold';
import { ago, around, cell, right } from './format';
import { errorText, formatTokens, titleOf } from '../gate/text';
import type { Status } from '../gate';
import { Footer, footerLines, HeaderBand, type Hint } from './parts';
import { ACCENT, BG, KIND_COLOR, MUTED, SELECTED_BG, TEXT, TONE } from './theme';

const PREVIEW_BLOCKS = 6;
// Columns besides the title: marker, updated, profile, Context, blocks.
const FIXED_COLUMNS = 60;
const KEYS: Hint[] = [['↑↓', 'select'], ['enter', 'open'], ['r', 'rename'], ['d', 'delete'], ['n', 'new'], ['/', 'filter'], ['esc', 'back']];
const EDIT_KEYS: Hint[] = [['enter', 'apply'], ['esc', 'cancel']];

const deleteQuestion = (dirty: boolean) =>
  dirty ? 'Delete this session? Its worktree has uncommitted changes – y removes them / N' : 'Delete this session? y / N';

type Editing = { kind: 'rename'; session: StoredSession } | { kind: 'filter' };

// open/create/remove switch the current session (remove returns the status text; force: remove the worktree's
// uncommitted changes too); back returns to the Gate. worktreeDirty: whether deleting would lose changes.
// elsewhere: where a session started when not in the current checkout (branch and directory), else null.
export type SessionsProps = {
  store: SessionStore;
  current: () => string;
  profiles: string[];
  windowOf: (profile: string) => number | undefined;
  open: (id: string) => Promise<void>;
  create: () => Promise<void>;
  remove: (id: string, force: boolean) => Promise<string>;
  worktreeDirty: (id: string) => boolean;
  elsewhere: (s: StoredSession) => string | null;
  rename: (id: string, title: string) => void;
  back: () => void;
};

export function Sessions(props: SessionsProps) {
  const size = useTerminalDimensions();
  const [all, setAll] = createSignal(props.store.list());
  const [filter, setFilter] = createSignal('');
  const [editing, setEditing] = createSignal<Editing | null>(null);
  const [draft, setDraft] = createSignal('');
  // The session to delete, and whether its worktree has uncommitted changes.
  const [confirm, setConfirm] = createSignal<{ session: StoredSession; dirty: boolean } | null>(null);
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

  function remove(s: StoredSession, force: boolean) {
    props.remove(s.id, force).then(text => {
      refresh();
      setStatus({ text, tone: 'info' });
    }, fail);
  }
  function finishEditing(apply: boolean) {
    const edit = editing()!;
    // An unchanged derived title is not fixed as a rename.
    const unchanged = edit.kind === 'rename' && !edit.session.renamed && draft().trim() === edit.session.title;
    if (edit.kind === 'rename' && apply && !unchanged) {
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
      if (s && !refused(s, '⊘ cannot delete: open in another instance')) setConfirm({ session: s, dirty: props.worktreeDirty(s.id) });
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
      if (key.name === 'y') remove(pending.session, pending.dirty);
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
  const hints = () => (editing() ? EDIT_KEYS : KEYS);
  const footerStatus = (): Status | null => (editing() ? null : confirm() ? { text: deleteQuestion(confirm()!.dirty), tone: 'error' } : status());
  // Session rows that fit: the screen less header band, column header, blank line, preview (header + blocks),
  // the input line while editing and the footer. Lines never shrink, so rows cannot overlap.
  const capacity = () =>
    Math.max(1, size().height - 2 - 1 - 1 - 1 - PREVIEW_BLOCKS - (editing() ? 1 : 0) - footerLines(footerStatus()?.text ?? '', hints(), size().width));
  const visible = () => around(list(), index(), capacity());
  // A profile that no longer exists is flagged ⚠ in the error colour.
  const profileOf = (s: StoredSession) =>
    props.profiles.includes(s.profile) ? { text: s.profile, fg: undefined } : { text: `⚠ ${s.profile}`, fg: TONE.error };
  const context = (s: StoredSession) => {
    const window = props.windowOf(s.profile);
    const tokens = s.tokens === null ? '–' : formatTokens(s.tokens);
    return { text: window && s.tokens !== null ? `${tokens}/${formatTokens(window)}` : tokens, warn: !!window && s.tokens! > 0.9 * window };
  };
  const preview = () => {
    const s = selected();
    if (!s) return [];
    const blocks = fold(s.events).blocks;
    return blocks.slice(-PREVIEW_BLOCKS).map((b, i) => ({ n: blocks.length - Math.min(PREVIEW_BLOCKS, blocks.length) + i + 1, block: b }));
  };

  const previewTitle = (s: StoredSession) => {
    const at = props.elsewhere(s);
    return ` · ${s.id} · last blocks${at ? ` · ${at}` : ''}`;
  };
  const heading = () => `Sessions · ${all().length} sessions${filter() ? ` · filter "${filter()}"` : ''}`;
  const isSelected = (s: StoredSession) => s.id === selected()?.id;

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={BG}>
      <HeaderBand width={size().width} title={<span style={{ fg: TEXT }}>{heading()}</span>} titleWidth={heading().length} />
      <text fg={MUTED} flexShrink={0}>{`     ${cell('Title', titleWidth())} ${'Updated'.padEnd(10)} ${'Profile'.padEnd(20)} ${'Context'.padEnd(14)} Blocks`}</text>
      <box flexDirection="column" flexGrow={1} overflow="hidden">
        <For each={visible()}>
          {s => (
            <text flexShrink={0} bg={isSelected(s) ? SELECTED_BG : undefined} fg={confirm()?.session === s ? TONE.error : TEXT}>
              <span style={{ fg: ACCENT }}>{`${isSelected(s) ? '┃' : ' '}${s.id === props.current() ? '●' : ' '}`}</span>
              <span style={{ fg: TONE.error }}>{`${s.locked ? '⊘' : ' '}  `}</span>
              <span>{`${cell(s.title, titleWidth())} `}</span>
              <span style={{ fg: MUTED }}>{`${ago(s.updated).padEnd(10)} `}</span>
              <span style={{ fg: profileOf(s).fg }}>{`${cell(profileOf(s).text, 20)} `}</span>
              <span style={{ fg: context(s).warn ? TONE.warn : undefined }}>{`${context(s).text.padEnd(14)} `}</span>
              <span style={{ fg: MUTED }}>{right(String(s.blocks), 6)}</span>
            </text>
          )}
        </For>
      </box>
      <text flexShrink={0}> </text>
      <Show when={selected()} fallback={<text flexShrink={0}> </text>}>
        {(s: () => StoredSession) => (
          <text flexShrink={0}>
            <span>{'  '}</span>
            <strong>
              <span style={{ fg: TEXT }}>{'Preview'}</span>
            </strong>
            <span style={{ fg: MUTED }}>{previewTitle(s())}</span>
          </text>
        )}
      </Show>
      <box flexDirection="column" height={PREVIEW_BLOCKS} flexShrink={0}>
        <For each={preview()}>
          {p => (
            <text>
              <span style={{ fg: MUTED }}>{`   ${right(String(p.n), 3)}  `}</span>
              <span style={{ fg: KIND_COLOR[p.block.kind] }}>{p.block.kind.padEnd(11)}</span>
              <span style={{ fg: TEXT }}>{`  ${cell(titleOf(p.block), titleWidth())}`}</span>
            </text>
          )}
        </For>
      </box>
      <Show when={editing()}>
        {(edit: () => Editing) => (
          <box flexDirection="row" flexShrink={0}>
            <text fg={ACCENT}>{edit().kind === 'rename' ? '┃ title > ' : '┃ / '}</text>
            <input focused value={draft()} onInput={onDraft} flexGrow={1} backgroundColor={BG} focusedBackgroundColor={BG} textColor={TEXT} focusedTextColor={TEXT} cursorColor={ACCENT} />
          </box>
        )}
      </Show>
      <Footer status={footerStatus()} hints={hints()} width={size().width} />
    </box>
  );
}
