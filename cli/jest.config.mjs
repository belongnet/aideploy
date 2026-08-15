/** Jest ESM config — mirrors the provisioner's runner (jest + experimental-vm-modules). */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      useESM: true,
      tsconfig: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        isolatedModules: true,
        types: ['node', 'jest']
      }
    }]
  },
  testMatch: ['**/test/**/*.test.ts']
};
