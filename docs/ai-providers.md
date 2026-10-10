# AI model providers

The app calls one AI model for scene analysis, plate / face / rule tracking and the chatbot. `AI_PROVIDER` chooses which service answers; the code that calls it does not change (`server/gemini.ts` → `server/llm.ts`).

## Where the keys go

Put them in the server's environment, the same place `GEMINI_API_KEY` already lives (hosting dashboard variables, or a `.env` file in the project root, which is git-ignored; `.env.example` lists the names). Keys are server-only and are never sent to the browser. The server does not read `.env` by itself: start it with `node --env-file=.env ...` or your host's variable settings. `npm run ai:bench` does read `.env`.

| Provider | `AI_PROVIDER` | Key variable | Other settings |
|---|---|---|---|
| Google Gemini (default) | `gemini` | `GEMINI_API_KEY` | none |
| Anthropic Claude | `anthropic` | `ANTHROPIC_API_KEY` | default model `claude-haiku-5-5` |
| OpenAI or any OpenAI-compatible endpoint (Qwen-VL on DashScope / Together / Fireworks / OpenRouter, a local vLLM) | `openai` | `OPENAI_API_KEY` (not needed for a local server) | `OPENAI_BASE_URL`, and `AI_VISION_MODELS` + `AI_CHAT_MODELS` (required: the model name depends on the host) |

Optional: `AI_VISION_MODELS` / `AI_CHAT_MODELS` (comma lists, tried in order, for any provider), `AI_TIMEOUT_MS` (default 25000), `AI_MAX_OUTPUT_TOKENS`, `OPENAI_JSON_MODE=false` (endpoint rejects `response_format`), `OPENAI_OMIT_TEMPERATURE=true` (model accepts only its default temperature).

Example, Qwen on DashScope:

```
AI_PROVIDER=openai
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
AI_VISION_MODELS=qwen-vl-max
AI_CHAT_MODELS=qwen-vl-max
```

Gateways (`npm run gateway`) use the same variables.

## Choosing: the benchmark

`npm run ai:bench` runs the app's real prompts on your own frames against any number of models and reports speed, JSON reliability, tokens, cost and, if you give it ground truth, accuracy. Put about 100 frames in `bench-frames/` and run:

```
npm run ai:bench -- --frames bench-frames --targets "gemini:gemini-3.6-flash,anthropic:claude-haiku-5-5,openai:qwen-vl-max@https://dashscope-intl.aliyuncs.com/compatible-mode/v1#DASHSCOPE_API_KEY" --prices "gemini-3.6-flash=IN,OUT;claude-haiku-5-5=IN,OUT;qwen-vl-max=IN,OUT"
```

`IN,OUT` are USD per million tokens from each provider's price page. A target is `provider:model[@baseUrl][#KEY_ENV_VAR]`. For accuracy, put `frame1.json` beside `frame1.jpg`: `{ "plates": ["MH12AB1234"], "people": 3, "vehicles": 2, "unusual": false }` (any key optional). Without it, models are compared with the first target. The report is written to `ai-benchmark-report/` (git-ignored; it contains your frames' content).

## Notes

- Face matching: hosted models may refuse to identify people from faces. Test it with the benchmark before relying on it.
- Switching providers changes answers; re-check alert thresholds (`isUnusual`, rule confidence) after a switch.
