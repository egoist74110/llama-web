// Application update state (also part of the live snapshot as `appUpdate`).
import { getContext } from '../../service/context'

export default defineEventHandler(() => getContext().appUpdate.view())
