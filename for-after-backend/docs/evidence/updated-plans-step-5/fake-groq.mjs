// Isolated browser check only: preloaded into the isolated API (`node --import <this> dist/main`) so the companion
// never reaches Groq. Requests to api.groq.com get a fixed fictional reply; every other fetch is untouched.
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url;
  if (typeof url === 'string' && url.startsWith('https://api.groq.com/')) {
    await new Promise((r) => setTimeout(r, 150));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'A fictional suggestion from the fake provider.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }
  return real(input, init);
};
console.log('[fake-groq] provider calls are faked in this process');
