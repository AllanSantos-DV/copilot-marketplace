// Worker de curadoria — roda como processo `node` LIMPO, separado do fork da extensão. Isto é
// deliberado: dentro do fork, o resolver hook do host redireciona a resolução de @github/copilot e
// quebra o CopilotClient ("Invalid command format"); num node filho limpo (sem os loaders/hooks do
// fork) o SDK resolve e sobe em segundos, como no standalone. Lê o PROMPT do stdin, cura via
// createSession, imprime a resposta crua do modelo no stdout. Erros → stderr + exit 1.
import { pathToFileURL } from "node:url";
import { join, delimiter } from "node:path";
import { existsSync } from "node:fs";

function sdkIndexUrl() {
    const env = String(process.env.COPILOT_MEMORY_SDK_PATH || "").trim();
    if (env && existsSync(env)) return pathToFileURL(env).href;
    for (const dir of String(process.env.PATH || "").split(delimiter)) {
        if (!dir || !dir.trim()) continue;
        for (const marker of ["copilot.ps1", "copilot.cmd", "copilot"]) {
            try {
                if (existsSync(join(dir, marker))) {
                    const sdk = join(dir, "node_modules", "@github", "copilot", "copilot-sdk", "index.js");
                    if (existsSync(sdk)) return pathToFileURL(sdk).href;
                }
            } catch { /* segue */ }
        }
    }
    return "@github/copilot-sdk";
}

function contentText(content) {
    if (content == null) return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : (p && typeof p.text === "string" ? p.text : ""))).join("");
    if (typeof content === "object" && typeof content.text === "string") return content.text;
    return "";
}
function assistantText(res) {
    if (!res) return "";
    if (typeof res === "string") return res;
    if (res.data && res.data.content != null) return contentText(res.data.content);
    if (res.content != null) return contentText(res.content);
    return "";
}

async function readStdin() {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString("utf8");
}

(async () => {
    let client = null, outText = null;
    try {
        const prompt = await readStdin();
        if (!prompt.trim()) { process.stderr.write("prompt vazio"); process.exitCode = 1; return; }
        const wd = process.env.COPILOT_MEMORY_CURATOR_CWD || process.cwd();
        const model = process.env.COPILOT_MEMORY_CURATOR_MODEL || "claude-sonnet-4.6";
        const { CopilotClient, approveAll } = await import(sdkIndexUrl());
        if (typeof CopilotClient !== "function") { process.stderr.write("CopilotClient indisponível"); process.exitCode = 1; return; }
        client = new CopilotClient({ workingDirectory: wd });
        await client.start();
        // Sessão determinística: por padrão APPEND (mantém o grounding do SDK, só acrescenta nossa diretriz),
        // pois REPLACE total piorou o foco do modelo. tools:[] → o worker não chama ferramenta nenhuma (só lê
        // texto e devolve texto/JSON). O system message extra reforça: sem voz/áudio, saída = só o pedido.
        const extraSys = process.env.COPILOT_MEMORY_CURATOR_SYS ||
            "Neste canal NÃO há voz, áudio nem a ferramenta de fala: nunca mencione isso. Responda apenas o que a " +
            "mensagem do usuário pedir (ex.: um objeto JSON), sem preâmbulo e sem comentar sobre ferramentas.";
        const session = await client.createSession({
            model,
            workingDirectory: wd,
            onPermissionRequest: approveAll,
            systemMessage: { mode: "append", content: extraSys },
            tools: [],
        });
        const res = await session.sendAndWait({ prompt }, Number(process.env.COPILOT_MEMORY_CURATOR_TIMEOUT || 150000));
        outText = assistantText(res);
        // 2º turno CONDICIONAL (COPILOT_MEMORY_CURATOR_TURN2): alguns ambientes injetam instruções
        // comportamentais via additionalContext SÓ no 1º prompt (ex.: a extensão de voz). Um 2º turno na MESMA
        // sessão vem limpo. Mas se o turn1 JÁ trouxe a saída estruturada (contém '"clean"'), PULA o turn2 —
        // economiza uma chamada de modelo cara (importa sob contenção in-session). Ver dogfood 2026-07-16.
        const turn2 = process.env.COPILOT_MEMORY_CURATOR_TURN2;
        if (turn2 && turn2.trim() && !/"clean"/.test(String(outText || ""))) {
            const t2Timeout = Math.min(60000, Number(process.env.COPILOT_MEMORY_CURATOR_TIMEOUT || 150000));
            const res2 = await session.sendAndWait({ prompt: turn2 }, t2Timeout);
            const t2 = assistantText(res2);
            if (t2 && t2.trim()) outText = t2;
        }
    } catch (e) {
        process.stderr.write(String(e?.message || e));
        process.exitCode = 1;
    } finally {
        if (client) { try { await client.stop(); } catch { /* ignore */ } }
    }
    // Escreve a saída e DRENA o pipe ANTES de encerrar. NUNCA usar process.exit() logo após stdout.write:
    // em POSIX o pipe é assíncrono e o exit imediato TRUNCA a resposta (o parent recebe JSON cortado e
    // conta como sucesso vazio). Aguardar o callback de write garante a entrega completa.
    if (outText != null) {
        await new Promise((r) => process.stdout.write(outText, () => r()));
    }
    process.exit(process.exitCode || 0);
})();
