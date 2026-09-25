// Opens the backend a Model Profile names.
import type { Backend } from '../../core/backend';
import type { BackendKind, ModelProfile } from '../../core/config/config';
import { connectLlamaCpp } from './llamacpp';

// Ollama and LM Studio follow in their own tickets.
export const isSupported = (backend: BackendKind) => backend === 'llamacpp';

export async function connect(profile: ModelProfile): Promise<Backend> {
  if (!isSupported(profile.backend)) throw new Error(`${profile.backend} backend not supported yet`);
  return connectLlamaCpp(profile.endpoint, profile);
}
