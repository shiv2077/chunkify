'use strict';

/* One way in and out for every model call.

   role "generate" -> a local llama.cpp OpenAI-compatible server, called
   straight from the browser. It is on localhost, it needs no key, and it is
   the cheap high-volume path.

   role "judge" -> POSTed to the local helper, which holds the provider key and
   forwards the call. No key ever reaches this file or localStorage.

   Both roles are optional. Nothing here throws on a missing backend; callers
   get a rejected promise with a message fit to show the user, and the app
   works without any of it. */

const LLM_DEFAULT_TIMEOUT_MS = 90000;

function llmEndpoint(role) {
  // No model for the judge: the helper picks it, because the helper holds the
  // key that the model name has to be valid for.
  return role === 'judge'
    ? { url: `${String(settings.helperBaseUrl).replace(/\/$/, '')}/judge`, model: null }
    : { url: `${String(settings.genBaseUrl).replace(/\/$/, '')}/chat/completions`, model: settings.genModel };
}

// Cached so a dead helper is not re-probed on every card. Cleared when the
// helper URL changes in settings.
let helperHealthPromise = null;

function helperHealth({ refresh = false } = {}) {
  if (refresh) helperHealthPromise = null;
  if (helperHealthPromise) return helperHealthPromise;

  const base = String(settings.helperBaseUrl || '').replace(/\/$/, '');
  helperHealthPromise = (base
    ? fetch(`${base}/health`, { signal: AbortSignal.timeout(2500) })
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null)
    : Promise.resolve(null));
  return helperHealthPromise;
}

function forgetHelperHealth() {
  helperHealthPromise = null;
}

/* chat(messages, {role}) -> Promise<string> of the assistant's reply. */
function chat(messages, { role = 'generate', temperature = 0, maxTokens = 700, json = false, schema = null, schemaName = 'reply' } = {}) {
  const { url, model } = llmEndpoint(role);
  const body = { messages, temperature, max_tokens: maxTokens };
  if (model) body.model = model;
  // A schema is worth the extra words: a small local model will otherwise drop
  // optional-looking fields, and a missing difficulty silently becomes 0.5,
  // which would quietly flatten every calibration measurement.
  if (schema) body.response_format = { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } };
  else if (json) body.response_format = { type: 'json_object' };

  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(LLM_DEFAULT_TIMEOUT_MS),
  })
    .then((res) =>
      res.json().catch(() => ({})).then((data) => {
        if (!res.ok) throw new Error(data.error && (data.error.message || data.error) || `${role} backend returned ${res.status}`);
        return data;
      })
    )
    .then((data) => {
      const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (typeof text !== 'string') throw new Error(`${role} backend returned no message content`);
      return text;
    })
    .catch((err) => {
      if (err.name === 'TimeoutError') throw new Error(`${role} backend timed out`);
      if (err instanceof TypeError) {
        throw new Error(role === 'judge'
          ? 'Helper is not running (start it with ./run.sh --helper)'
          : `Local generator is not answering at ${settings.genBaseUrl}`);
      }
      throw err;
    });
}

// Models wrap JSON in prose or fences often enough to be worth handling here
// rather than in every caller.
function parseJsonReply(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[[{]/);
  if (start === -1) throw new Error('Model reply contained no JSON');
  const end = Math.max(body.lastIndexOf(']'), body.lastIndexOf('}'));
  // no closing bracket after the opening one means the reply stopped mid-JSON,
  // which is a token limit, not malformed output. Say so.
  if (end < start) throw new Error('Model reply was cut off before it finished — raise the token limit or ask for fewer cards');
  return JSON.parse(body.slice(start, end + 1));
}

function chatJson(messages, opts) {
  return chat(messages, Object.assign({ json: true }, opts)).then(parseJsonReply);
}
