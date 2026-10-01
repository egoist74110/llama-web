// reka-ui's <SelectItem> throws for value '' (it means "clear selection"), so an option that stands
// for "no value" travels through the select as a sentinel and is mapped back to '' on the way out.
export const EMPTY_SELECT_VALUE = '__none__'

export interface SelectItemDef { label: string, value: string }

/** Items with a leading "empty" option whose select value is the sentinel, not ''. */
export function withEmptyOption(emptyLabel: string, items: SelectItemDef[]): SelectItemDef[] {
  return [{ label: emptyLabel, value: EMPTY_SELECT_VALUE }, ...items]
}

/** Stored value ('' = none) -> value the select understands. */
export const toSelectValue = (v: string | null | undefined): string => (v ? v : EMPTY_SELECT_VALUE)

/** Value emitted by the select -> stored value ('' = none). */
export const fromSelectValue = (v: unknown): string => (v === EMPTY_SELECT_VALUE || v == null ? '' : String(v))
