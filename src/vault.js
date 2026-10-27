// Escrita segura no Punk Records.
//
// O vault é editado por humano e por vários modelos. Reescrever uma nota inteira já
// custou caro nesse repositório: uma regeneração em 2026-07-05 apagou ~51 entradas de
// índice. Por isso tudo que é gerado vive dentro de marcadores, e só o miolo entre eles
// é substituído — a prosa em volta é de quem escreveu, e continua lá.
//
// Mesma convenção que `tools/notion_ingest.py` já usa no vault (blocos REL e MENTIONS).

export function slugVault(s) {
  return String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

/**
 * Substitui (ou insere) um bloco gerenciado dentro do conteúdo.
 * Insere antes de `## Related` quando existe, para a nota terminar pelos links.
 */
export function injetarBloco(conteudo, chave, bloco) {
  if (!/^[A-Z0-9-]+$/.test(chave)) throw new TypeError('chave de bloco invalida');
  const ini = `<!-- ${chave}:START -->`;
  const fim = `<!-- ${chave}:END -->`;
  const novo = `${ini}\n${bloco}\n${fim}`;
  const re = new RegExp(`${ini}[\\s\\S]*?${fim}`);
  if (re.test(conteudo)) return conteudo.replace(re, novo);
  if (conteudo.includes('\n## Related')) return conteudo.replace('\n## Related', `${novo}\n\n## Related`);
  return `${conteudo.trimEnd()}\n\n${novo}\n`;
}

/**
 * Agrupa eventos por mês. O vault proíbe misturar anos num arquivo, e a chave é
 * derivada da data do próprio evento — nunca da data de hoje.
 */
export function agruparPorMes(eventos) {
  const porMes = {};
  for (const e of eventos) {
    if (!e?.data || !/^\d{4}-\d{2}-\d{2}/.test(e.data)) continue;
    (porMes[e.data.slice(0, 7)] ||= []).push(e);
  }
  for (const mes of Object.keys(porMes)) {
    porMes[mes].sort((a, b) => a.data.localeCompare(b.data));
  }
  return porMes;
}
