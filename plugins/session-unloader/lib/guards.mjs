// guards.mjs — as travas de segurança ANTES de qualquer kill. Nenhuma sozinha basta; TODAS têm de passar.
//   1. pid vivo               (senão nada a fazer)
//   2. auto-preservação       (nunca a própria sessão/scan nem seus ancestrais)
//   3. anti-TOCTOU            (o pid AINDA é um servidor --server --stdio; senão PID reciclado → aborta)
//   4. sem daemon compartilhado na descendência (não derruba memory/embed-house/etc que servem TODAS
//      as sessões) — e a varredura falha FECHADA se não conseguir enxergar tudo.
// Ponte cross-session NÃO é guardada (decisão do ADR: se a sessão-ponte está ociosa, morre — trade-off aceito).
//
// A guarda 4 varre TODA A DESCENDÊNCIA, não só os filhos diretos. Motivo medido (2026-07-30): o daemon
// de memória (java) pendura sob o PROCESSO DA EXTENSÃO copilot-memory, que pendura sob o servidor —
// logo é NETO. Olhar um nível enquanto o treeKill mata N níveis é uma assimetria que apagou o
// mcp-memory da máquina do dono. O alcance da guarda tem de ser o mesmo alcance do tiro.
//
// ASSIMETRIA DE CUSTO (a regra que decide todos os empates aqui): proteger demais custa RAM não
// liberada e é TRANSITÓRIO; proteger de menos MATA um daemon que serve todas as sessões. Na dúvida,
// protege.

export const SINGLETON_RE = /action-mcp|embed-house|mcp-memory|server-http\.mjs|memory.*daemon/i;

// Shells/consoles. NÃO servem para negar proteção — só para não CONTAMINAR a contagem de
// "por sessão" (ver `tokensPorSessao`) e para escolher o melhor MOTIVO a exibir: a cmdline deles
// cita caminhos o tempo todo. As âncoras ^$ são obrigatórias: sem elas, `sh` casaria dentro de
// `ssh.exe`/`bash.exe`/`flush.exe` e classificaria processo alheio como shell.
export const SHELL_RE = /^(pwsh|powershell|cmd|conhost|bash|sh|wsl)\.exe$/i;

// Qual token da SINGLETON_RE casou nesta cmdline (normalizado) — a IDENTIDADE do daemon.
// É o token, não o nome do processo: o mesmo daemon aparece como cmd.exe, node.exe ou .exe
// próprio dependendo de como foi lançado.
export function tokenSingleton(proc) {
  const m = SINGLETON_RE.exec(String(proc?.cmdline || ""));
  return m ? m[0].toLowerCase() : null;
}

// O EXECUTÁVEL da cmdline (primeiro token, com ou sem aspas) — sem os argumentos.
export function caminhoImagem(cmdline) {
  const s = String(cmdline || "").trim();
  if (!s) return "";
  if (s[0] === '"') { const f = s.indexOf('"', 1); return f === -1 ? s.slice(1) : s.slice(1, f); }
  const esp = s.indexOf(" ");
  return esp === -1 ? s : s.slice(0, esp);
}

// Token casado apenas na IMAGEM (o binário), ignorando os argumentos. É o critério para
// CLASSIFICAR (decisão perigosa: rebaixar um token tira proteção). A proteção em si usa a cmdline
// inteira, que é o critério seguro — ele pega o wrapper cujo token só existe no argv.
export function tokenNaImagem(proc) {
  const m = SINGLETON_RE.exec(caminhoImagem(proc?.cmdline));
  return m ? m[0].toLowerCase() : null;
}

/**
 * Tokens que, MEDINDO a árvore, se revelam POR SESSÃO — não daemons compartilhados.
 *
 * Um MCP server stdio é um processo por sessão (é assim que stdio funciona): o mesmo token aparece
 * sob VÁRIOS servidores, um exemplar para cada. Matá-lo junto com a sessão é correto — ele morreria
 * de qualquer jeito. Um daemon compartilhado de verdade é UM só na máquina e aparece sob no máximo
 * um servidor. Medido: `action-mcp` em 6 servidores distintos (per-session) × `mcp-memory` em 1.
 *
 * É uma regra MEDIDA, não uma lista de nomes: um MCP por sessão que exista amanhã é classificado
 * sozinho, e um daemon que hoje é por sessão e vire singleton passa a ser protegido sozinho.
 *
 * DOIS cuidados, ambos aprendidos com regressão medida (a classificação é a decisão PERIGOSA — ela
 * TIRA proteção — então cada carrier precisa ser o daemon de verdade, não uma menção a ele):
 *   - conta só quem carrega o token na IMAGEM (o executável). Um `node.exe` de Program Files cujo
 *     ARGUMENTO citava `.mcp-memory` (script de diagnóstico) rebaixou o token e desarmou a proteção
 *     do daemon de memória na máquina do dono.
 *   - cada processo conta para o servidor MAIS PRÓXIMO na cadeia. Com servidor aninhado em servidor,
 *     o mesmo processo era contado sob 2 servidores "distintos" e inflava a contagem.
 */
export function tokensPorSessao(procMap) {
  const ehServidor = (pid) => /--server --stdio/.test(String(procMap.get(pid)?.cmdline || ""));
  // servidor mais próximo subindo a cadeia (null se o processo não está sob nenhum)
  const servidorMaisProximo = (pid) => {
    let cur = procMap.get(pid)?.ppid, n = 0;
    while (cur !== undefined && procMap.has(cur) && n < 200) {
      if (ehServidor(cur)) return cur;
      cur = procMap.get(cur).ppid;
      n++;
    }
    return null;
  };
  const servidoresPorToken = new Map();
  for (const [pid, info] of procMap) {
    if (SHELL_RE.test(String(info.name || ""))) continue;
    const t = tokenNaImagem(info);
    if (!t) continue;
    const s = servidorMaisProximo(pid);
    if (s === null) continue;             // daemon solto (destacado) não é per-session
    const set = servidoresPorToken.get(t) || new Set();
    set.add(s);
    servidoresPorToken.set(t, set);
  }
  const porSessao = new Set();
  for (const [token, servs] of servidoresPorToken) if (servs.size >= 2) porSessao.add(token);
  return porSessao;
}

// Conjunto de PIDs ancestrais de `pid` (subindo por ppid). Inclui o pai imediato até a raiz.
export function ancestorsOf(pid, procMap) {
  const anc = new Set();
  let cur = Number(pid), guard = 0;
  while (procMap.has(cur) && guard < 40) {
    const { ppid } = procMap.get(cur);
    if (anc.has(ppid)) break;
    anc.add(ppid);
    cur = ppid;
    guard++;
  }
  return anc;
}

// Filhos DIRETOS de `pid` no procMap.
export function childrenOf(pid, procMap) {
  const kids = [];
  const target = Number(pid);
  for (const [cpid, info] of procMap) if (info.ppid === target) kids.push({ pid: cpid, ...info });
  return kids;
}

/**
 * TODA a descendência de `pid` (filhos, netos, bisnetos…) — o mesmo alcance do treeKill.
 * BFS com `vistos` para não repetir nem entrar em laço se o SO devolver ppid cíclico.
 *
 * SEM teto de profundidade por padrão, de propósito: `taskkill /T` não tem teto, e um teto aqui
 * recria a MESMA assimetria que causou o incidente, só que mais fundo (medido pelo gate: cadeia
 * real de 46 níveis, guarda enxergava 41, 6 processos morriam cegos). `vistos` já garante
 * terminação em ciclo e o custo é O(N) — 200 mil nós em 18 ms.
 *
 * Devolve `{ descendentes, truncado }`. `truncado` só aparece quando o chamador PEDE um teto, e
 * existe para a varredura parcial nunca virar um "não achei singleton" indistinguível de uma
 * varredura completa (fail-silent).
 */
export function descendantsOf(pid, procMap, { maxDepth = Infinity } = {}) {
  const porPai = new Map();
  for (const [cpid, info] of procMap) {
    const arr = porPai.get(info.ppid);
    if (arr) arr.push(cpid); else porPai.set(info.ppid, [cpid]);
  }
  const descendentes = [];
  const vistos = new Set([Number(pid)]);
  let fronteira = [Number(pid)];
  let d = 0;
  for (; d < maxDepth && fronteira.length; d++) {
    const prox = [];
    for (const p of fronteira) {
      for (const c of porPai.get(p) || []) {
        if (vistos.has(c)) continue;
        vistos.add(c);
        descendentes.push({ pid: c, ...procMap.get(c) });
        prox.push(c);
      }
    }
    fronteira = prox;
  }
  return { descendentes, truncado: fronteira.length > 0 };
}

/**
 * Decide se PODE descarregar o servidor. Retorna { ok:true } ou { ok:false, reason }.
 * @param {{pid:number}} server
 * @param {{selfPid:number, selfAncestors:Set<number>, procMap:Map, pidAlive:(n:number)=>boolean,
 *          perSessionTokens?:Set<string>}} ctx
 */
export function guardKill(server, { selfPid, selfAncestors, procMap, pidAlive, perSessionTokens, maxDepth }) {
  const pid = Number(server.pid);
  if (!pidAlive(pid)) return { ok: false, reason: "pid-morto" };
  if (pid === selfPid) return { ok: false, reason: "self-pid" };
  if (selfAncestors.has(pid)) return { ok: false, reason: "ancestral-do-scan" };
  const cur = procMap.get(pid);
  if (!cur || !/--server --stdio/.test(cur.cmdline)) return { ok: false, reason: "cmdline-mudou-TOCTOU" };

  const { descendentes, truncado } = descendantsOf(pid, procMap,
    maxDepth === undefined ? {} : { maxDepth });
  const porSessao = perSessionTokens || new Set();
  const candidatos = descendentes.filter((k) => {
    const t = tokenSingleton(k);
    return t !== null && !porSessao.has(t);
  });
  // Shell TAMBÉM protege (na dúvida, protege), mas é o pior motivo para MOSTRAR: `pwsh -c cat
  // ~/.mcp-memory/...` aparecendo como razão esconde o daemon de verdade e faz o diagnóstico
  // mentir sobre POR QUE aquele servidor está protegido.
  const compartilhado = candidatos.find((k) => !SHELL_RE.test(String(k.name || ""))) || candidatos[0];
  if (compartilhado) return { ok: false, reason: `hospeda-singleton:${compartilhado.name}` };
  // Não achamos singleton — mas só vale se a varredura foi COMPLETA. Truncada, o "não achei" não
  // significa "não tem": é o mesmo fail-silent que apagou o mcp-memory, um nível abaixo.
  if (truncado) return { ok: false, reason: "descendencia-profunda-demais-nao-varri-tudo" };
  return { ok: true };
}
