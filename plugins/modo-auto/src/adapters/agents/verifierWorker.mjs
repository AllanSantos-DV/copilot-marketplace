// verifierWorker.mjs — WORKER do shadow-verifier (node LIMPO, fire-and-die). Diferente do worker.mjs comum
// (tools:[]), este sobe com TOOLS CUSTOM read-only (verifyTools) e availableTools FAIL-CLOSED (só elas — zero
// built-ins, zero shell). Recebe {claim, repo, model} no stdin; roda UM turno pedindo veredito factual; imprime
// JSON {holds, evidence, toolCalls} no stdout. holds=true → alegação CONFIRMADA; false → REFUTADA; null → indeterminado.
// FAIL LOUD: falha real vira {ok:false,error} no stdout (o adapter trata). É a "mão" que deixa o sombra VERIFICAR.
import { sdkIndexUrl, textOf, runTurnWithHeartbeat } from "./workerLib.mjs";
import { verifyTools, VERIFY_TOOL_NAMES } from "../shadow/verifyTools.mjs";
import { makeSubmitTool, runUntilSubmitted } from "./structuredResult.mjs";

// TOOL TEMPLATE do veredito do verificador (Princípio 11) — holds tri-estado via enum (o SDK impõe o schema).
const VERDICT_SCHEMA = {
  name: "submit_verdict",
  description: "Envie o veredito factual sobre a alegação, com base SOMENTE nas ferramentas read-only.",
  parameters: {
    type: "object",
    properties: {
      holds: { type: "string", enum: ["true", "false", "unknown"], description: "true=alegação confirmada; false=refutada pela evidência; unknown=as ferramentas não bastam" },
      evidence: { type: "string", description: "o achado concreto (ex.: 'git_grep count=3 em server.mjs' ou 'path_exists exists=false')" },
    },
    required: ["holds", "evidence"],
  },
};

async function readStdin() { const chunks = []; for await (const c of process.stdin) chunks.push(c); return Buffer.concat(chunks).toString("utf8"); }

(async () => {
  let client = null;
  try {
    const job = JSON.parse((await readStdin()) || "{}");
    const claim = String(job.claim || "").trim();
    const repo = String(job.repo || process.env.MODO_AUTO_WORKER_CWD || process.cwd());
    const model = job.model || process.env.MODO_AUTO_WORKER_MODEL || "claude-haiku-4.5";
    if (!claim) { process.stdout.write(JSON.stringify({ ok: false, error: "claim vazio" })); return; }

    const { CopilotClient, approveAll } = await import(sdkIndexUrl());
    if (typeof CopilotClient !== "function") { process.stdout.write(JSON.stringify({ ok: false, error: "CopilotClient indisponível" })); process.exitCode = 1; return; }
    client = new CopilotClient({ workingDirectory: repo });
    await client.start();

    const toolCalls = [];
    const submit = makeSubmitTool(VERDICT_SCHEMA);
    const session = await client.createSession({
      model, workingDirectory: repo, onPermissionRequest: approveAll,
      systemMessage: { mode: "append", content:
        "Você é um VERIFICADOR FACTUAL de background. Sua ÚNICA função: dizer se a ALEGAÇÃO sobre o repositório é " +
        "VERDADEIRA ou FALSA, usando SOMENTE suas ferramentas read-only (nada de opinião). Chame as ferramentas " +
        "de verificação necessárias e, ao final, CHAME a ferramenta submit_verdict com holds (true/false/unknown) e evidence. " +
        "holds=true: a alegação se confirma. holds=false: a alegação é refutada pela evidência. holds=unknown: as ferramentas não bastam para decidir. " +
        "NÃO responda em texto — o veredito é APENAS via submit_verdict." },
      tools: [...verifyTools, submit.tool], // tools read-only + a submit (tool template do veredito)
      availableTools: [...VERIFY_TOOL_NAMES, submit.name], // FAIL-CLOSED: só estas + submit — zero built-ins, zero shell
    });

    const onAct = (e) => { try { process.stderr.write("\x1e"); } catch { /* ignore */ } const n = e?.data?.toolName; if (n && /execution_start/i.test(String(e?.type))) toolCalls.push(n); };

    // Verificação read-only + veredito via tool template. runUntilSubmitted força a submit_verdict (loop limitado)
    // e captura NO INSTANTE da chamada. Se genuinamente não submeter → {ok:false} SINALIZADO (o adapter trata).
    let parsed;
    try {
      const first = `REPO: ${repo}\nALEGAÇÃO A VERIFICAR:\n"${claim}"\n\nUse suas ferramentas (passe repo="${repo}") e finalize chamando submit_verdict.`;
      let firstTurn = true;
      parsed = await runUntilSubmitted(
        (p) => runTurnWithHeartbeat(session, firstTurn ? (firstTurn = false, first) : p, { model, idleGraceMs: 90000, onActivity: onAct }),
        submit, { retries: 2 });
    } catch (e) { process.stdout.write(JSON.stringify({ ok: false, error: "turno: " + (e?.message || e) })); return; }

    if (!parsed || !("holds" in parsed)) { process.stdout.write(JSON.stringify({ ok: false, error: "verificador não submeteu {holds}", toolCalls })); return; }
    const holds = parsed.holds === "true" ? true : parsed.holds === "false" ? false : null;
    process.stdout.write(JSON.stringify({ ok: true, holds, evidence: String(parsed.evidence || "").slice(0, 400), toolCalls }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: "worker: " + (e?.message || e) }));
    process.exitCode = 1;
  } finally { try { await client?.stop?.(); } catch { /* ignore */ } }
})();
