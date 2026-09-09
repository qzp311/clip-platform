declare module "@xenova/transformers" {
  export function pipeline(
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ): Promise<
    (
      audio: Float32Array,
      options?: Record<string, unknown>,
    ) => Promise<{
      text: string;
      chunks?: Array<{ text: string; timestamp: [number, number | null] }>;
    }>
  >;
}
