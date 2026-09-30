// First start: pick one of the models found on the local ports; it becomes the default Model Profile.
import { useKeyboard, useTerminalDimensions } from '@opentui/solid';
import { createSignal, For } from 'solid-js';
import { isSupported } from '../adapters/backend/connect';
import type { DiscoveredModel } from '../adapters/backend/discover';
import type { BackendKind } from '../core/config/config';
import { cell } from './format';
import { Footer, HeaderBand } from './parts';
import { ACCENT, BG, MUTED, SELECTED_BG, TEXT } from './theme';

const BACKEND_NAME: Record<BackendKind, string> = { llamacpp: 'llama.cpp', ollama: 'Ollama', lmstudio: 'LM Studio', omlx: 'oMLX' };

export function Setup(props: { found: DiscoveredModel[]; configPath: string; onChoose: (model: DiscoveredModel) => void; onQuit: () => void }) {
  const [selected, setSelected] = createSignal(0);
  const select = (i: number) => setSelected(Math.max(0, Math.min(props.found.length - 1, i)));
  const keys: Record<string, () => void> = {
    up: () => select(selected() - 1),
    down: () => select(selected() + 1),
    return: () => {
      const model = props.found[selected()]!;
      if (isSupported(model.backend)) props.onChoose(model);
    },
    q: props.onQuit,
    escape: props.onQuit,
  };
  useKeyboard(key => keys[key.name]?.());
  const size = useTerminalDimensions();
  const heading = 'first start';
  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={BG}>
      <HeaderBand width={size().width} title={<span style={{ fg: TEXT }}>{heading}</span>} titleWidth={heading.length} />
      <text fg={MUTED}>{`  Choose a model; it becomes the default Model Profile in ${props.configPath}`}</text>
      <text> </text>
      <For each={props.found}>
        {(found, i) => (
          <text bg={i() === selected() ? SELECTED_BG : undefined}>
            <span style={{ fg: ACCENT }}>{i() === selected() ? '┃ ' : '  '}</span>
            <span style={{ fg: isSupported(found.backend) ? TEXT : MUTED }}>
              {`${cell(BACKEND_NAME[found.backend], 10)}  ${cell(found.model, 24)}  ${cell(found.endpoint, 22)}`}
              {isSupported(found.backend) ? '' : '  unsupported'}
            </span>
          </text>
        )}
      </For>
      <box flexGrow={1} />
      <Footer status={null} hints={[['↑↓', 'select'], ['enter', 'choose'], ['q', 'quit']]} width={size().width} />
    </box>
  );
}
