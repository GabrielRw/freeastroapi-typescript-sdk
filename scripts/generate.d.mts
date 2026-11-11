// Types for scripts/generate.mjs, used by test/generator.test.ts.
export interface GenerateResult {
  files: Record<string, string>;
  ops: Array<Record<string, unknown>>;
  schemaCount: number;
}

export function generate(spec: unknown): GenerateResult;
