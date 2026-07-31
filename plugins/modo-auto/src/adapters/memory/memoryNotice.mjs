// Aviso ao HUMANO sobre o estado da memória na mesa. Puro de propósito: a regra de "o que o dono precisa saber"
// tem que ser testável sem subir extensão, e o `extension.mjs` só a consome.
//
// POR QUE EXISTE: a mesa rodando SEM memória era indistinguível da mesa rodando COM. O modelo recebia um JSON
// dizendo "indisponível", mas o dono via só o resultado — e uma deliberação feita às cegas parecia idêntica a
// uma deliberação informada. É o mesmo defeito que passei a sessão inteira caçando dentro do código (falha que
// não se anuncia), só que na camada de cima, onde ela é pior: quem decide se aquilo basta é o humano.
//
// A ORIGEM do escopo entra no aviso porque é o único jeito de o humano pegar o escopo ERRADO — o furo que o
// fail-loud NÃO cobre. Quem está num fork vê o remote do fork; quem tem marcador antigo vê um id que já não é o
// do projeto. O código não tem como saber que está errado; o dono tem.

/**
 * Linha CURTA de status, para ir junto do RESULTADO da tool — não no log.
 *
 * Por que existe: o aviso completo saía por `logHost`, que escreve no log da sessão do host. Numa sessão por
 * VOZ ou por daemon (que é como este produto costuma ser usado), o dono NUNCA vê aquilo — ou seja, a mesa
 * rodando cega continuava indistinguível da mesa informada, exatamente o defeito que o aviso deveria matar.
 * Log é para quem depura; o RESULTADO é o que o humano recebe. Esta linha viaja no resultado.
 * @returns {string} uma linha, sem markdown, segura para ser lida em voz alta
 */
/**
 * EVENTO ESTRUTURADO do estado da memória, para ser emitido A CADA deliberação (não uma vez por processo).
 *
 * Por que estruturado e por que por-rodada: o aviso saía por log, UMA vez por processo, sob um guard. Isso
 * falha em três frentes ao mesmo tempo — (a) o log da sessão do host é invisível em voz/daemon, (b) uma vez por
 * processo significa que a 2ª deliberação em diante não avisa nada, e (c) texto solto não é consultável nem
 * agregável. Um objeto com campos fixos pode ser logado, contado e conferido; uma frase, não.
 * @returns {{ evento:"memoria.estado", ativa:boolean, escopo:string|null, origem:string, risco:string|null,
 *             alternativa:string|null, mensagem:string, em:string }}
 */
export function eventoMemoria({ escopo = null, origem = "?", motivo = "", suspeita = null } = {}) {
  const a = avisoMemoria({ escopo, origem, motivo, suspeita });
  return {
    evento: "memoria.estado",
    ativa: a.ativa,
    escopo: escopo || null,
    origem: escopo ? String(origem) : "none",
    risco: (suspeita && suspeita.risco) || null,
    alternativa: (suspeita && suspeita.alternativa) || null,
    mensagem: a.texto,
    em: new Date().toISOString(),
  };
}

/**
 * Rótulo ÚNICO para exibição, que junta origem e suspeita numa string que não dá para ler pela metade.
 *
 * Existe por uma razão concreta: `source` responde "de onde veio o id" e `risco` responde "é o projeto certo?".
 * São perguntas DIFERENTES, e fundi-las perderia informação (um fork resolve por `git-remote` — se `source`
 * virasse "fork", ninguém mais saberia se veio de remote ou de marcador). Mas um consumidor que lê só `source`
 * veria "git-remote" e concluiria que está tudo normal. Este rótulo é a saída: quem exibe origem exibe o
 * alerta junto, por construção.
 */
export function rotuloEscopo({ origem = "?", risco = null } = {}) {
  const base = origem === "declared" ? "declarado" : origem === "git-remote" ? "git remote" : String(origem);
  return risco ? `${base} · ${String(risco).toUpperCase()}` : base;
}

export function statusMemoriaCurto({ escopo = null, origem = "?", suspeita = null } = {}) {
  // Sem memória o dono precisa do CONSERTO junto, não só do diagnóstico: é o único caso em que ele tem algo a
  // fazer. O aviso longo (com o mesmo conserto) ia por log — invisível em voz/daemon, medido. Colocar aqui é o
  // que faz a instrução chegar de fato a quem pode agir.
  if (!escopo) {
    return "MEMÓRIA: indisponível — esta deliberação rodou SEM o acervo do projeto (os agentes não viram decisões anteriores). " +
      "Para ligar: instale o plugin copilot-memory e trabalhe num repo com git remote origin, ou crie .memory/project.json com metadata.defaults.project_id.";
  }
  if (suspeita && suspeita.risco === "fork" && suspeita.alternativa) {
    return `MEMÓRIA: ativa no escopo ${escopo}, mas este repo parece um FORK (upstream ${suspeita.alternativa}) — o acervo lido é o do fork.`;
  }
  if (suspeita && suspeita.risco === "submodule") {
    return `MEMÓRIA: ativa no escopo ${escopo}, que é de um SUBMODULE${suspeita.alternativa ? ` dentro de ${suspeita.alternativa}` : ""} — o acervo lido é o do submodule, não o do projeto que o contém.`;
  }
  if (suspeita && suspeita.risco === "espelho") {
    return `MEMÓRIA: ativa no escopo ${escopo}, porém o diretório é um artefato ANINHADO em outro repositório — confira se o escopo é o projeto certo.`;
  }
  const de = origem === "declared" ? "declarado" : origem === "git-remote" ? "git remote" : origem;
  return `MEMÓRIA: ativa no escopo ${escopo} (${de}), somente leitura.`;
}

/**
 * @param {{ escopo?: string|null, origem?: string, motivo?: string, suspeita?: object|null }} a
 * @returns {{ ativa: boolean, texto: string }}
 */
export function avisoMemoria({ escopo = null, origem = "?", motivo = "", suspeita = null } = {}) {
  if (!escopo) {
    const porque = motivo ? ` (${String(motivo).split(".")[0]})` : " (plugin copilot-memory ausente ou escopo não resolvível)";
    return {
      ativa: false,
      texto:
        `⚠️ a mesa vai deliberar SEM memória do projeto${porque}. Isso NÃO impede o trabalho, mas os agentes não ` +
        `veem decisões anteriores. Para ligar: instale o copilot-memory e trabalhe num repo com git remote origin, ` +
        `ou crie .memory/project.json com metadata.defaults.project_id.`,
    };
  }
  const comoVeio = origem === "declared" ? "declarado em .memory/project.json"
    : origem === "git-remote" ? "derivado do git remote origin"
    : String(origem);
  // FORK detectado: em vez do convite genérico "confira se é o projeto certo", o aviso vira ESPECÍFICO, com os
  // dois ids na mão. O código não escolhe (só o dono sabe se quer o acervo do fork ou o do upstream) — mas
  // "existe um upstream diferente" é um fato medível, e escondê-lo seria a mesma degradação silenciosa de novo.
  if (suspeita && suspeita.risco === "fork" && suspeita.alternativa) {
    return {
      ativa: true,
      texto:
        `⚠️ memória ATIVA no escopo "${escopo}" (${comoVeio}) — mas este repositório parece um FORK: existe um ` +
        `remote 'upstream' diferente ("${suspeita.alternativa}"). Os agentes vão ler o acervo do FORK, não o do ` +
        `projeto original. Se você quer o acervo de "${suspeita.alternativa}", crie .memory/project.json com ` +
        `metadata.defaults.project_id = "${suspeita.alternativa}" — o marcador declarado vence o remote.`,
    };
  }
  return {
    ativa: true,
    texto:
      `memória do projeto ATIVA para a mesa — escopo "${escopo}" (${comoVeio}). Os agentes podem consultar o ` +
      `acervo deste projeto, SOMENTE LEITURA. Se este não é o projeto que você espera (fork, mirror, submodule, ` +
      `marcador antigo), corrija antes de deliberar: o acervo consultado será o desse escopo.`,
  };
}
