// What this computer is: CPU, memory and (Windows) the NVIDIA driver / CUDA / compute capability, or
// (Mac) chip, cores and memory, with recommendations and warnings. Read-only; `?refresh=1` detects again.
import { getContext } from '../service/context'

export default defineEventHandler((event) => getContext().getSystem({ refresh: getQuery(event).refresh === '1' }))
