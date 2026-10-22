import OpenAI from 'openai';

/**
 * xAI (Grok) client via the OpenAI-compatible API.
 * Passing apiKey 'mock' (XAI_MOCK=1) returns an offline stub that produces
 * deterministic JSON derived from the prompt, so the full pipeline
 * (Binance → indicators → prompt → parse → gates → Discord payload) can be
 * exercised without a key. Mock output is NOT analysis.
 */
export function createXaiClient(apiKey: string): any {
  if (apiKey === 'mock') return mockClient();
  return new OpenAI({
    baseURL: process.env.XAI_BASE_URL || 'https://api.x.ai/v1',
    apiKey,
    timeout: 250000,
  });
}

function firstNumber(re: RegExp, text: string): number | null {
  const m = text.match(re);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

function round(n: number): number {
  const d = n >= 1000 ? 1 : n >= 10 ? 2 : 4;
  return Number(n.toFixed(d));
}

function mockClient() {
  return {
    chat: {
      completions: {
        create: async (req: any) => {
          const system: string = req.messages?.find((m: any) => m.role === 'system')?.content || '';
          const user: string = req.messages?.find((m: any) => m.role === 'user')?.content || '';
          const price = firstNumber(/Price: \$([\d.,]+)/, user) ?? 100;
          const atr = firstNumber(/ATR\(14\): \$([\d.,]+)/, user) ?? price * 0.01;
          const frames = Array.from(new Set(Array.from(user.matchAll(/\b(\d+[mhdw])\b/gi)).map((m) => m[1].toLowerCase()))).slice(0, 2);
          const section = (tf: string) => ({
            bias: 'neutral',
            summary: `[MOCK] ${tf} placeholder summary — offline mode, no model was called.`,
            keyLevels: [`${round(price - atr)} support (mock)`, `${round(price + atr)} resistance (mock)`],
          });
          const insights: any = { overallSummary: '[MOCK] Offline mock analysis. Set XAI_API_KEY for real Grok output.' };
          for (const tf of frames) insights[tf] = section(tf);
          let body: any;
          if (/Never produce a trade plan/.test(system)) {
            body = { multiTFInsights: insights };
          } else {
            const ids = Array.from(user.matchAll(/id[=:]\s*"?([0-9a-zA-Z-]{6,})/g)).map((m) => m[1]);
            const entry = round(price - atr * 1.5);
            const stop = round(entry - atr * 2);
            const risk = entry - stop;
            body = {
              multiTFInsights: insights,
              openTradeReviews: ids.map((id) => ({ id, action: 'keep', reason: 'mock keep' })),
              bestTrades: [
                {
                  direction: 'LONG',
                  grade: 'B',
                  setupType: 'pending',
                  triggerZone: `${round(entry - atr * 0.3)}-${round(entry + atr * 0.3)}`,
                  triggerCondition: '[MOCK] reclaim of zone after sweep',
                  entry,
                  stopLoss: stop,
                  targets: [round(entry + risk * 2), round(entry + risk * 3.5)],
                  entryConfirmType: 'reclaim',
                  entryConfirmLevel: entry,
                  stopLiftTrigger: round(entry + risk),
                  stopLiftTo: entry,
                  confluenceSignals: ['mock OB', 'mock FVG', 'mock OTE', 'mock EMA'],
                  riskRewardRatio: 2,
                  reasoning: '[MOCK] Placeholder setup to exercise the pipeline. Not a real idea.',
                },
              ],
            };
          }
          return {
            choices: [{ message: { role: 'assistant', content: JSON.stringify(body) } }],
            usage: { prompt_tokens: Math.round(user.length / 4), completion_tokens: 400 },
          };
        },
      },
    },
  };
}
