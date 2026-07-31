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
 * @param {{ escopo?: string|null, origem?: string, motivo?: string }} a
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
