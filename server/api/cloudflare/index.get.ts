// What the one-click setup card starts from: whether an API token is saved (masked) and the
// current / last failed setup run. No call to Cloudflare.
import { getContext } from '../../service/context'
import { tokenView } from '../../service/cloudflare-api'

export default defineEventHandler(() => ({ ...tokenView(), job: getContext().cloudflare.status() }))
