// Orquestrador da PIPELINE PARALELA (fatiador → execução). Amarra tudo:
//   1) garante repo + git-flow (gitOrchestrator) — projeto `folder` sem git → git init baseline;
//   2) fatia em GRUPOS (dag.buildGroups a partir das deps do fatiador);
//   3) worktree DEDICADO de integração (develop);
//   4) p/ cada GRUPO: cria os braços (worktrees), roda as fases EM PARALELO (cada uma no seu braço via
//      modo-dev), commita cada braço, MERGEIA em develop (conflito → papel merge-resolver), remove o braço;
//   5) FAIL LOUD em qualquer etapa real; verdicts pass/escalate do tech-lead são SURFACED (não engolidos).
// Isolamento TOTAL: integração e braços são worktrees irmãos; o worktree ATIVO da sessão nunca é tocado.

import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";
import { buildGroups } from "./dag.mjs";
import { resolveAll } from "./escalation.mjs";
import * as git from "../git/gitOrchestrator.mjs";
import { branchFor, commitMessage } from "../git/gitFlow.mjs";

// Tira cercas de código (```lang ... ```) que o resolver possa ter adicionado — o arquivo tem que sair cru.
function stripFences(t) {
  const s = String(t || "").trim();
  const m = s.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  return m ? m[1] : s;
}

export function createPipeline({ log = () => {}, dev } = {}) {
  if (!dev?.develop) throw new Error("createPipeline: dev (modo-dev) ausente");

  // Resolve UM conflito via papel merge-resolver (sub-agente). FAIL LOUD se o resolver falhar.
  async function resolveConflict(caps, phaseId, file, sides, objective) {
    if (!caps?.factory?.run) throw new Error("pipeline: caps.factory ausente p/ resolver conflito");
    const prompt =
      `Conflito de merge no arquivo "${file}" (fase ${phaseId}).\n\nOBJETIVO DA FASE:\n${objective}\n\n` +
      `LADO ATUAL (ours):\n${sides.ours || "(vazio)"}\n\nLADO ENTRANDO (theirs):\n${sides.theirs || "(vazio)"}\n\n` +
      `Devolva SOMENTE o conteúdo final resolvido do arquivo INTEIRO, sem marcadores de conflito.`;
    const r = await caps.factory.run("merge-resolver", prompt, { subject: "merge-resolver", timeoutMs: 120000 });
    if (!r.ok || typeof r.text !== "string" || !r.text.trim()) throw new Error(`pipeline: merge-resolver falhou p/ "${file}": ${r.error || "sem texto"}`);
    return stripFences(r.text);
  }

  return {
    id: "pipeline",
    /**
     * @param {{ id:string, text:string }[]} phases  fases do plano (id único + descrição)
     * @param {Record<string,string[]>} deps          dependências entre fases (saída do fatiador)
     * @param {{ factory?:object, gate?:object, memory?:object }} caps
     * @param {{ taskType?:string, rootCwd?:string, deep?:boolean, maxRounds?:number }} [opts]
     */
    async run(phases, deps = {}, caps = {}, { taskType = null, rootCwd = process.cwd(), deep = false, maxRounds } = {}) {
      if (!Array.isArray(phases) || !phases.length) throw new Error("pipeline.run: sem fases");
      for (const p of phases) if (!p || !p.id || !p.text) throw new Error("pipeline.run: fase precisa de { id, text }");

      const ctx = git.ensureRepo(rootCwd);      // FAIL LOUD dentro
      const root = ctx.root;
      git.ensureGitFlow(root);
      const { groups, parallel, maxWidth } = buildGroups(phases.map((p) => p.id), deps); // FAIL LOUD em ciclo
      const byId = new Map(phases.map((p) => [p.id, p]));

      const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const wroot = join(tmpdir(), "modo-auto-arms", runId);
      mkdirSync(wroot, { recursive: true });
      const intgPath = join(wroot, "integration");
      const created = [];
      const results = [];
      log(`[pipeline] ${phases.length} fases em ${groups.length} grupos (paralelo=${parallel}, largura máx=${maxWidth})`);

      try {
        git.addIntegration(root, intgPath);
        created.push(intgPath);

        for (let gi = 0; gi < groups.length; gi++) {
          const group = groups[gi];
          const arms = group.map((id) => ({ id, branch: branchFor("feature", id), path: join(wroot, "arm-" + id) }));
          // cria os braços SEQUENCIALMENTE (git worktree add pode travar o .git); build em PARALELO depois.
          for (const arm of arms) { git.addArm(root, { branch: arm.branch, path: arm.path }); created.push(arm.path); }
          log(`[pipeline] grupo ${gi + 1}/${groups.length}: ${arms.length} fase(s) em paralelo → ${group.join(", ")}`);

          const built = await Promise.all(arms.map(async (arm) => {
            const phase = byId.get(arm.id);
            const res = await dev.develop(phase.text, caps, { taskType, cwd: arm.path, deep, maxRounds }); // FAIL LOUD se papel falhar
            const commit = git.commitAll(arm.path, commitMessage("feat", `fase ${arm.id}`, { scope: "modo-dev", body: `pass=${res.pass}` }));
            return { arm, res, commit };
          }));

          // merges SERIALIZADOS no worktree de integração (mesmo index).
          for (const b of built) {
            if (b.commit.committed) {
              const m = git.mergeArm(intgPath, b.arm.branch, { message: commitMessage("chore", `integra ${b.arm.id}`, { scope: "pipeline" }) });
              if (!m.ok) {
                log(`[pipeline] conflito ao integrar ${b.arm.id}: ${m.conflicts.join(", ")} → merge-resolver`);
                for (const file of m.conflicts) {
                  const sides = git.conflictSides(intgPath, file);
                  git.resolveFile(intgPath, file, await resolveConflict(caps, b.arm.id, file, sides, byId.get(b.arm.id).text));
                }
                git.commitMerge(intgPath); // FAIL LOUD se sobrar conflito
              }
            }
            results.push({ id: b.arm.id, pass: !!b.res.pass, committed: b.commit.committed, escalate: b.res.escalate || null });
            git.removeWorktree(root, b.arm.path);
          }
        }

        const failed = results.filter((r) => !r.pass);
        // ESCALAÇÕES → sobem pro orquestrador (mesa). Resolvidas viram contexto; não-resolvidas → humano.
        const raw = results.filter((r) => r.escalate).map((r) => ({ id: r.id, question: r.escalate }));
        const escalations = raw.length ? await resolveAll(raw, caps) : [];
        const forHuman = escalations.filter((e) => !e.resolved);
        log(`[pipeline] concluído: ${results.length} fases, ${failed.length} reprovadas, ${escalations.length} escalações (${forHuman.length} p/ humano) → integradas em develop`);
        return { ok: true, groups, parallel, maxWidth, integrationBranch: "develop", results, escalations, forHuman };
      } finally {
        for (const p of created) git.removeWorktree(root, p);
        rmSync(wroot, { recursive: true, force: true });
      }
    },
  };
}
