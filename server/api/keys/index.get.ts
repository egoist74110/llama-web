// API keys for the public entry, masked (the key itself is never listed).
import { describeKeys } from '../../service/keys-api'

export default defineEventHandler(() => describeKeys())
