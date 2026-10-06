// External upstreams (decision 56) with their last health probe; the API key itself is never listed.
import { describeUpstreams } from '../../service/upstreams-api'

export default defineEventHandler(() => describeUpstreams())
