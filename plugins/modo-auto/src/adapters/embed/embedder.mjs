// EMBEDDER do modo-sombra — drift determinístico (MiniLM-L6 384-dim). CONSUMIDOR PURO da CASA DE EMBEDDINGS
// ÚNICA e COMPARTILHADA (daemon único p/ N plugins, provisionada em ~/.embed-house/bin). O modelo NUNCA carrega
// no host da extensão e o modo-auto NÃO empacota/sobe servidor próprio. SEM fallback in-process (decisão do
// dono: casa ÚNICA). Se a casa não sobe, embed() devolve null SINALIZADO e o caller (drift/convergência)
// degrada p/ heurístico — resultado ausente e sinalizado, nunca fake calado. NUNCA lança.
const HOUSE_MODEL = "Xenova/all-MiniLM-L6-v2"; // modelo FIXO que a casa única serve (protocol atado a {model,dim})
const COOLDOWN_MS = 30000;                     // após a casa falhar, espera 30s antes de re-tentar (anti self-DDoS)

// `cacheDir`/`device` permanecem na assinatura por compat de callers, mas NÃO são mais processados (não há
// mais carga in-process). Limpeza da API pública fica p/ refactor futuro do embedder (dívida registrada no ADR).
export function createEmbedder({ log = () => {}, model = HOUSE_MODEL, cacheDir, device, useDaemon = true, cooldownMs = COOLDOWN_MS, client: _client = null } = {}) {
  let _mode = null;    // "daemon" | null (null = ainda não decidido, ou voltou a indeciso após falha)
  let _port = null;
  let _deciding = null;
  let _lastFailAt = 0; // timestamp da última falha da casa → gate de cooldown (não fica cego nem em loop)

  // A casa serve UM modelo fixo e NÃO há in-process: um override de modelo não é atendível → FAIL-LOUD null.
  const _eligible = useDaemon && model === HOUSE_MODEL;
  if (useDaemon && model !== HOUSE_MODEL)
    log(`[embed] FAIL-LOUD: modelo '${model}' ≠ modelo da casa ('${HOUSE_MODEL}') e SEM in-process → embed() devolve null (override sinalizado; nunca serve o modelo errado calado)`);

  // Cliente da casa (injetável p/ teste; import LAZY p/ degradar se o cliente estiver ausente).
  async function client() {
    if (_client) return _client;
    try { _client = await import("../../../embed-house/ensureDaemon.mjs"); return _client; }
    catch (e) { log(`[embed] cliente da casa indisponível (${e?.message || e})`); return null; }
  }

  // Resolve o endpoint da casa. Cooldown: se falhou há < COOLDOWN_MS, NÃO re-tenta (evita loop de I/O contra
  // uma casa morta). Após o cooldown, tenta de novo (ensureDaemon re-sobe a casa se o binário existe). Nunca lança.
  async function decide() {
    if (_mode === "daemon" && _port) return "daemon";
    if (!_eligible) return null;
    if (_lastFailAt && Date.now() - _lastFailAt < cooldownMs) return null; // em cooldown → sem casa por ora
    if (_deciding) return _deciding;
    _deciding = (async () => {
      const c = await client();
      if (c?.ensureDaemon) {
        try {
          const r = await c.ensureDaemon({ log });
          if (r.available) { _mode = "daemon"; _port = r.port; _lastFailAt = 0; log(`[embed] via CASA única (porta ${_port}) — modelo NÃO carregado no host`); return "daemon"; }
          log(`[embed] casa indisponível (${r.reason}) → sem embedding real; heurístico sinalizado (cooldown ${cooldownMs / 1000}s)`);
        } catch (e) { log(`[embed] ensureDaemon erro (${e?.message || e}) → cooldown ${cooldownMs / 1000}s`); }
      }
      _mode = null; _port = null; _lastFailAt = Date.now(); // arma o cooldown; volta a indeciso (não cega permanente)
      return null;
    })();
    try { return await _deciding; } finally { _deciding = null; }
  }

  return {
    // true se HÁ uma casa viva. Nunca lança.
    async available() { return (await decide()) === "daemon"; },
    // Vetor 384-dim (mean-pooled, normalizado) ou null. Sem casa → null SINALIZADO (caller usa heurístico).
    // Se a casa cai no meio, volta a indeciso + arma cooldown (NÃO fica cego) e re-tenta após o cooldown. Nunca lança.
    async embed(text) {
      if ((await decide()) !== "daemon") return null; // sem casa → null (heurístico). SEM in-process.
      try {
        const c = await client();
        const v = await c.embedBatch(_port, [String(text || "")]);
        if (Array.isArray(v) && Array.isArray(v[0])) return Float32Array.from(v[0]);
        throw new Error("casa devolveu vetor vazio");
      } catch (e) {
        log(`[embed] casa falhou (${e?.message || e}) → null; re-decide após cooldown (não fica cego)`);
        _mode = null; _port = null; _lastFailAt = Date.now();
        return null;
      }
    },
  };
}
