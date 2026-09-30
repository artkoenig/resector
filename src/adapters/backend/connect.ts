// Opens the backend a Model Profile names.
import type { Backend } from '../../gate/ports';
import type { BackendKind, ModelProfile } from '../../core/config/config';
import { connectLlamaCpp } from './llamacpp';
import { connectOmlx } from './omlx';

// Ollama and LM Studio follow in their own tickets.
type Open = (endpoint: string, options: ModelProfile & { session: string }) => Promise<Backend>;
const CONNECT: Partial<Record<BackendKind, Open>> = {
  llamacpp: connectLlamaCpp,
  omlx: connectOmlx,
};

export const isSupported = (backend: BackendKind) => backend in CONNECT;

// session: the Session the backend serves (llama.cpp pins a slot per session).
export async function connect(profile: ModelProfile, session: string): Promise<Backend> {
  const open = CONNECT[profile.backend];
  if (!open) throw new Error(`${profile.backend} backend not supported yet`);
  return open(profile.endpoint, { ...profile, session });
}
