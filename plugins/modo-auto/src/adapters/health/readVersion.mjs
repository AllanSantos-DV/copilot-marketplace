// readVersion.mjs — leitura da `version` de um package.json/plugin.json, INJETÁVEL (exists/read por parâmetro,
// mesmo padrão de setupCheck.mjs). Extraído para cá porque setupCheck.mjs e buildProvenance.mjs precisavam do
// MESMO comportamento (arquivo ausente/ilegível → null, nunca lança) — reúso, não duplicação (DRY).
export const readVersion = (pkgJsonPath, { exists, read }) => {
  try { return exists(pkgJsonPath) ? (JSON.parse(String(read(pkgJsonPath, "utf8"))).version || null) : null; }
  catch { return null; }
};
