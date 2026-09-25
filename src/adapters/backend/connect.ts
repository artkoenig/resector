// Opens the backend a Model Profile names.
import type { Backend } from '../../core/backend';
import type { BackendKind, ModelProfile } from '../../core/config/config';
import { connectLlamaCpp } from './llamacpp';
import { connectOmlx } from './omlx';

// Ollama and LM Studio follow in their own tickets.
const CONNECT: Partial<Record<BackendKind, (endpoint: string, profile: ModelProfile) => Promise<Backend>>> = {
  llamacpp: connectLlamaCpp,
  omlx: connectOmlx,
};

export const isSupported = (backend: BackendKind) => backend in CONNECT;

export async function connect(profile: ModelProfile): Promise<Backend> {
  const open = CONNECT[profile.backend];
  if (!open) throw new Error(`${profile.backend} backend not supported yet`);
  return open(profile.endpoint, profile);
}
