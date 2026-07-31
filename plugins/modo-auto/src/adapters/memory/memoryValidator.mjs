// VALIDADOR DE MEMÓRIA — o papel que LÊ o que a memória trouxe e CONTESTA item a item, sem editar nada.
//
// POR QUE EXISTE: a memória entrava no prompt como CONTEXTO PASSIVO ("use isto"), e ninguém perguntava se o
// item ainda vale. Memória de projeto envelhece: uma decisão de três meses atrás pode ter sido revertida, e o
// agente a trata como verdade porque ela chegou junto com o resto. O resultado é a mesa construindo em cima de
// premissa morta — e o pior é que isso NÃO parece um erro, parece contexto.
//
// READ-ONLY ESTRUTURAL, NÃO POR COMBINAÇÃO: o validador roda com `availableTools: []`, ou seja, o SDK só lhe
// oferece a tool de submissão do veredito. Ele não tem tool de memória, não tem tool de arquivo, não tem shell.
// Não é que ele "não deve" salvar: ele não TEM como. Fronteira que depende de disciplina volta a vazar no dia
// que alguém adiciona um papel novo; fronteira que depende de capacidade ausente, não.
//
// ANTI-ALUCINAÇÃO DE CITAÇÃO: o veredito é conferido contra a lista de `doc_id` REALMENTE injetados. Um modelo
// que inventa um id (ou devolve o id de outro item) tem o veredito DESCARTADO e sinalizado. Sem isso, "citar a
// fonte" seria teatro: o id existiria no texto sem existir no corpus.

import { MEMORY_TOOL_NAMES } from "./memoryTools.mjs";

/** Tool template (Princípio 11): o veredito vem de uma TOOL com schema imposto pelo SDK, não de prosa parseada. */
export const MEMORY_VERDICT_SCHEMA = {
  name: "submit_memory_audit",
  description: "Julgue CADA item de memória recuperado: ele ainda se aplica a este assunto?",
  parameters: {
    type: "object",
    properties: {
      itens: {
        type: "array",
        description: "um veredito por item recebido, na mesma quantidade",
        items: {
          type: "object",
          properties: {
            doc_id: { type: "string", description: "o id EXATO do item julgado, copiado da lista recebida" },
            veredito: { type: "string", description: "aplica | desatualizado | nao_se_aplica" },
            razao: { type: "string", description: "por que, em uma frase objetiva" },
          },
          required: ["doc_id", "veredito", "razao"],
        },
      },
    },
    required: ["itens"],
  },
};

export const VEREDITOS = Object.freeze(["aplica", "desatualizado", "nao_se_aplica"]);

/**
 * Concilia o veredito do modelo com os itens REALMENTE injetados. Puro de propósito: é aqui que mora a defesa
 * contra citação inventada, e ela precisa ser testável sem spawnar worker.
 *
 * Regras (todas fail-visible, nenhuma silenciosa):
 *  • id que não está na lista injetada → veredito INVÁLIDO (o modelo inventou ou trocou), item NÃO é julgado.
 *  • veredito fora do enum → INVÁLIDO.
 *  • item injetado que o modelo NÃO julgou → fica como `aplica` por omissão. Escolha deliberada: descartar o
 *    não-julgado deixaria o modelo apagar memória legítima só por esquecer de listá-la, o que é pior (perda
 *    silenciosa) do que manter um item que talvez estivesse velho (que a mesa ainda pode contestar).
 * @param {{doc_id:string,text:string}[]} injetados
 * @param {{doc_id?:string,veredito?:string,razao?:string}[]} vereditos
 */
export function conciliarVereditos(injetados, vereditos) {
  const validos = new Set((injetados || []).map((i) => i && i.doc_id).filter(Boolean));
  const julgado = new Map();
  const invalidos = [];
  for (const v of Array.isArray(vereditos) ? vereditos : []) {
    const id = v && v.doc_id ? String(v.doc_id) : "";
    const ver = v && v.veredito ? String(v.veredito).trim().toLowerCase() : "";
    if (!validos.has(id)) { invalidos.push({ doc_id: id || "(vazio)", motivo: "id não estava entre os itens injetados (citação inventada)" }); continue; }
    if (!VEREDITOS.includes(ver)) { invalidos.push({ doc_id: id, motivo: `veredito fora do enum: "${ver}"` }); continue; }
    julgado.set(id, { veredito: ver, razao: v.razao ? String(v.razao) : "" });
  }
  const itens = (injetados || []).filter((i) => i && i.doc_id).map((i) => {
    const j = julgado.get(i.doc_id);
    return { ...i, veredito: j ? j.veredito : "aplica", razao: j ? j.razao : "(não julgado — mantido por omissão)", julgado: !!j };
  });
  return {
    itens,
    aplicaveis: itens.filter((i) => i.veredito === "aplica"),
    descartados: itens.filter((i) => i.veredito !== "aplica"),
    invalidos,
  };
}

/** Monta o prompt do auditor. Separado para o teste poder afirmar o que o modelo REALMENTE recebe. */
export function promptAuditoria(assunto, itens, { podeBuscar = false } = {}) {
  return (
    `ASSUNTO EM PAUTA:\n${assunto}\n\n` +
    `ITENS DE MEMÓRIA RECUPERADOS (${itens.length}) — julgue CADA UM:\n` +
    itens.map((i) => `[${i.doc_id}] ${i.text}`).join("\n\n") +
    `\n\nSua função é AUDITAR, não resumir e não concordar. Para cada item diga se ele ` +
    `AINDA se aplica ao assunto acima:\n` +
    `• "aplica" — continua válido e é útil aqui.\n` +
    `• "desatualizado" — já foi verdade, mas foi superado/revertido por algo mais novo (diga por quê).\n` +
    `• "nao_se_aplica" — é de outro assunto/contexto e só polui esta deliberação.\n\n` +
    (podeBuscar
      ? `Você TEM a ferramenta memory_search (somente leitura, no acervo deste projeto). Use-a quando suspeitar ` +
        `que um item foi SUPERADO: ache o registro mais novo e cite-o na razão. Sem isso, "desatualizado" é ` +
        `palpite; com isso, é verificação. Use com parcimônia (poucas buscas).\n\n`
      : "")
    +
    `Copie o doc_id EXATAMENTE como recebido. NÃO invente id. NÃO julgue item que não está na lista.\n` +
    `CHAME a ferramenta submit_memory_audit. NÃO responda em texto.`
  );
}

/**
 * Roda a auditoria com um worker REAL. Degradação HONESTA: se o auditor falhar (modelo fora, sem submit), a
 * memória segue INTEIRA e SINALIZADA — auditor quebrado não pode apagar o contexto do projeto, seria trocar
 * "memória velha" por "nenhuma memória", que é o defeito pior. FAIL LOUD só para erro de programação (factory
 * ausente).
 *
 * `temMemoria` diz se o auditor pode BUSCAR — e isso é uma correção de rota, não um extra. A versão anterior o
 * proibia de buscar "porque ele só consolida material dado". Três auditorias apontaram o furo: para dizer
 * "desatualizado" ele precisa achar o que superou o item. Sem busca, aquele veredito era um JULGAMENTO
 * apresentado como verificação. Note que é um BOOLEANO, não o escopo: quem crava o escopo é a factory, e passar
 * a string aqui seria reabrir a porta que foi fechada (um chamador apontando o agente para outro projeto).
 * @param {{ factory:object, assunto:string, itens:{doc_id:string,text:string}[], log?:(m:string)=>void,
 *           timeoutMs?:number, temMemoria?:boolean }} a
 */
export async function auditarMemoria({ factory, assunto, itens, log = () => {}, timeoutMs = 90000, temMemoria = false } = {}) {
  if (!factory || !factory.run) throw new Error("auditarMemoria: factory ausente (config inválida)");
  const alvo = (itens || []).filter((i) => i && i.doc_id && i.text);
  if (!alvo.length) return { ok: true, auditado: false, ...conciliarVereditos(alvo, []), motivo: "nenhum item citável para auditar" };

  const r = await factory.run("revisor", promptAuditoria(assunto, alvo, { podeBuscar: !!temMemoria }), {
    subject: "auditor-memoria",
    timeoutMs,
    schema: MEMORY_VERDICT_SCHEMA,
    // FAIL-CLOSED COM EXCEÇÃO DECLARADA: a allowlist é a declaração de intenção do chamador. Aqui ela nomeia
    // `memory_search` de propósito — o auditor pode CONFERIR, e nada mais. Sem memória, volta a ser text-only
    // puro (lista vazia + submit), que é o comportamento correto quando não há acervo.
    availableTools: temMemoria ? [...MEMORY_TOOL_NAMES] : [],
    ...(temMemoria ? {} : { semMemoria: true }),
  });
  if (!r.ok || !r.text) {
    log(`[memoria] auditor indisponível (${r.error || "sem texto"}) — memória segue SEM auditoria (sinalizado, não é "tudo válido")`);
    return { ok: false, auditado: false, error: r.error || "sem texto", ...conciliarVereditos(alvo, []) };
  }
  let parsed = null;
  try { parsed = typeof r.text === "string" ? JSON.parse(r.text) : r.text; } catch { parsed = null; }
  if (!parsed || !Array.isArray(parsed.itens)) {
    log(`[memoria] auditor não submeteu vereditos — memória segue SEM auditoria (sinalizado)`);
    return { ok: false, auditado: false, error: "sem submit", ...conciliarVereditos(alvo, []) };
  }
  const c = conciliarVereditos(alvo, parsed.itens);
  if (c.invalidos.length) log(`[memoria] ${c.invalidos.length} veredito(s) DESCARTADO(s) por citação inválida: ${c.invalidos.map((i) => i.doc_id + " (" + i.motivo + ")").join("; ")}`);
  if (c.descartados.length) log(`[memoria] auditoria: ${c.descartados.length} de ${c.itens.length} item(ns) marcados como não-aplicáveis — ${c.descartados.map((i) => i.doc_id + ":" + i.veredito).join(", ")}`);
  return { ok: true, auditado: true, ...c };
}

/** Renderiza o resultado da auditoria para o prompt da mesa: o que aplica, e o que foi contestado (e por quê). */
export function renderAuditado(res, { max = 220 } = {}) {
  const aplic = (res.aplicaveis || []).map((i) => `- [${i.doc_id}] ${String(i.text).slice(0, max)}`).join("\n");
  if (!res.descartados || !res.descartados.length) return aplic;
  // O contestado NÃO some: ele aparece rotulado. Some seria esconder da mesa que existia conhecimento e que
  // alguém o julgou inválido — e é justamente esse julgamento que a mesa pode querer discordar.
  const desc = res.descartados.map((i) => `- [${i.doc_id}] (${i.veredito.toUpperCase()}: ${i.razao})`).join("\n");
  return `${aplic}\n\nCONTESTADO PELA AUDITORIA DE MEMÓRIA (não use como verdade; conteste se discordar):\n${desc}`;
}
