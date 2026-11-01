// Shared by the /api/web-search routes: the view the settings page works with and error mapping (decision 67).
import { fmt, t } from '../core/i18n'
import { StoreError } from '../core/store'
import { describeWebSearch, WebSearchAdminError, type WebSearchView } from '../core/web-search/admin'
import { getContext } from './context'

export function viewWebSearch(): WebSearchView {
  const ctx = getContext()
  return describeWebSearch(ctx.getSettings().webSearch, t.webPrompt.defaultGuide, ctx.getSecrets().searchKeys, ctx.webSearch.status())
}

/** Turn a validation / store failure into an HTTP error in the dictionary language; other errors pass through. */
export function webSearchError(e: unknown): never {
  if (e instanceof WebSearchAdminError) throw createError({ statusCode: 400, message: t.webSearch.errors[e.code] })
  if (e instanceof StoreError) throw createError({ statusCode: 409, message: fmt(t.webSearch.errors.store, { detail: e.message }) })
  throw e
}
