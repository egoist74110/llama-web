// Current settings as the settings page edits them (see service/settings-api.ts).
import { describeSettings } from '../../service/settings-api'

export default defineEventHandler(() => describeSettings())
