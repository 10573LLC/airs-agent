import {build} from 'vite';
import {resolve} from 'node:path';
await build({configFile:false,resolve:{alias:{'@':resolve('src')}},build:{ssr:'scripts/exercise-agents.ts',outDir:'.exercise-agent',target:'node22',rollupOptions:{output:{entryFileNames:'runner.mjs'}}}});
