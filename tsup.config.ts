import {defineConfig} from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    contracts: 'src/contracts/index.ts',
    cli: 'src/cli/index.ts',
  },
  clean: true,
  dts: true,
  format: ['esm'],
  platform: 'node',
  sourcemap: true,
  target: 'node22',
  treeshake: true,
});
