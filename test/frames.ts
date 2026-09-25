// Waits for a rendered frame in OpenTUI tests. Rendering waits on real HTTP (the fake backend), so
// frames are polled over time rather than a fixed number of render passes (`waitForFrame`).
import type { testRender } from '@opentui/solid';

export async function frameMatching(ui: Awaited<ReturnType<typeof testRender>>, predicate: (frame: string) => boolean): Promise<string> {
  for (let i = 0; i < 200; i++) {
    await ui.renderOnce();
    const current = ui.captureCharFrame();
    if (predicate(current)) return current;
    await Bun.sleep(10);
  }
  throw new Error(`no matching frame:\n${ui.captureCharFrame()}`);
}
