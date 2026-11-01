// The web search switch and the state of each backend (keys are never returned, only whether one is saved).
import { viewWebSearch } from '../../service/web-search-api'

export default defineEventHandler(() => viewWebSearch())
