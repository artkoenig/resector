// Regenerates config.schema.json from the config schema in Core.
import { configJsonSchema } from '../src/core/config/config';

await Bun.write(`${import.meta.dir}/../config.schema.json`, JSON.stringify(configJsonSchema(), null, 2) + '\n');
