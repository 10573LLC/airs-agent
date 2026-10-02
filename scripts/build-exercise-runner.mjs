import {build} from 'rolldown';
import {resolve} from 'node:path';
await build({input:'scripts/run-anconison-exercise.ts',platform:'node',external:['pg','node:crypto'],resolve:{alias:{'@':resolve('src')}},output:{file:'scripts/run-anconison-exercise.mjs',format:'esm'}});
