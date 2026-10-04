// The shortcut uses 0 for unlimited; llama-server uses -1. Stored/raw args keep their semantics.
export const validThinkingLimit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export const thinkingBudget = (limit: number): number => limit === 0 ? -1 : limit

export const displayThinkingLimit = (budget: string | number | null | undefined): string | number =>
  budget === -1 || budget === '-1' || budget === null || budget === undefined ? 0 : budget
