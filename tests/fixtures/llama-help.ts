// Excerpts from the installed b11146 llama-server --help.
export const B11146_HELP = `
----- common params -----

-h,    --help, --usage                  print usage and exit
--version                               show version and build info
--completion-bash                       print source-able bash completion script for llama.cpp
--cpu-strict <0|1>                      use strict CPU placement (default: 0)
--poll <0...100>                        use polling level to wait for work (0 - no polling, default: 50)
-c,    --ctx-size N                     size of the prompt context (default: 0, 0 = loaded from model)
-n,    --predict, --n-predict N         number of tokens to predict (default: -1, -1 = infinity)
-b,    --batch-size N                   logical maximum batch size (default: 2048)
-ub,   --ubatch-size N                  physical maximum batch size (default: 512)
-fa,   --flash-attn [on|off|auto]       set Flash Attention use ('on', 'off', or 'auto', default: 'auto')
--perf, --no-perf                       whether to enable internal libllama performance timings (default:
                                        false)
-ctk,  --cache-type-k TYPE              KV cache data type for K
                                        allowed values: f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1
                                        (default: f16)
                                        (env: LLAMA_ARG_CACHE_TYPE_K)
-ctv,  --cache-type-v TYPE              KV cache data type for V
                                        allowed values: f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1
                                        (default: f16)
                                        (env: LLAMA_ARG_CACHE_TYPE_V)
-dt,   --defrag-thold N                 KV cache defragmentation threshold (DEPRECATED)
                                        (env: LLAMA_ARG_DEFRAG_THOLD)
-lm,   --load-mode MODE                 model loading mode (default: auto)
-ngl,  --gpu-layers, --n-gpu-layers N   max. number of layers to store in VRAM, either an exact number,
-dev,  --device <dev1,dev2,..>          comma-separated list of devices to use for offloading (none = don't
-sm,   --split-mode {none,layer,row,tensor}
                                        how to split the model across multiple GPUs, one of:
                                        - none: use one GPU only
                                        - layer (default): split layers and KV across GPUs (pipelined)
-m,    --model FNAME                    model path to load
-hff,  --hf-file FILE                   Hugging Face model file. If specified, it will override the quant in
                                        --hf-repo (default: unused)
                                        (env: LLAMA_ARG_HF_FILE)
--spec-draft-type-k, -ctkd, --cache-type-k-draft TYPE
                                        KV cache data type for K for the draft model
                                        allowed values: f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1
                                        (default: f16)
--spec-draft-type-v, -ctvd, --cache-type-v-draft TYPE
                                        KV cache data type for V for the draft model
                                        allowed values: f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1
                                        (default: f16)
--host HOST                             IP addresses to listen on, comma-separated, or UNIX socket paths
--port PORT                             port to listen (default: 8080)
--jinja, --no-jinja                     whether to use jinja template engine for chat (default: enabled)
-np,   --parallel N                     number of server slots (default: -1, -1 = auto)
--reasoning-format FORMAT               controls whether thought tags are allowed and/or extracted from the
-rea,  --reasoning [on|off|auto]        Use reasoning/thinking in the chat ('on', 'off', or 'auto', default:
--reasoning-budget N                    token budget for thinking: -1 for unrestricted, 0 for immediate end,
--prefill-assistant, --no-prefill-assistant
`
