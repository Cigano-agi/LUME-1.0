// Canais de aviso. Nenhum deles usa o WhatsApp: o aviso de que o WhatsApp caiu
// nao pode depender do WhatsApp (regra do mandato).
//
// `arquivo` e o canal minimo que ja funciona hoje, sem custo e sem credencial.
// `webhook` fica pronto para quando houver um destino autorizado. Um canal de
// e-mail/SMS entra aqui como mais uma funcao -- e uma decisao do dono, nao do codigo.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";

export function avisoArquivo(caminho) {
  mkdirSync(dirname(caminho), { recursive: true });
  return async (aviso) => {
    appendFileSync(caminho, JSON.stringify(aviso) + "\n", "utf8");
  };
}

export function avisoConsole(saida = console.error) {
  return async (aviso) => {
    saida(`[ASSESSOR] ${aviso.tipo.toUpperCase()} em ${aviso.componente} (${aviso.em})`);
  };
}

/**
 * Notificacao nativa do Windows. E o unico canal que aparece sozinho na frente do dono
 * sem ele lembrar de abrir nada -- um aviso que so existe num .jsonl nao avisa ninguem.
 * Vai por -EncodedCommand para nenhum acento ou aspa do texto virar erro de parse.
 */
export function notificarWindows(titulo, texto) {
  const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$tpl = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t = $tpl.GetElementsByTagName('text')
$t.Item(0).AppendChild($tpl.CreateTextNode(${aspasPs(titulo)})) | Out-Null
$t.Item(1).AppendChild($tpl.CreateTextNode(${aspasPs(texto)})) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($tpl)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)
`;
  execFileSync("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(ps, "utf16le").toString("base64")], {
    stdio: "ignore",
    timeout: 20_000,
  });
}

const aspasPs = (s) => `'${String(s).replace(/'/g, "''")}'`;

export function avisoToast(titulo = "Lume") {
  return async (aviso) => {
    const quando = new Date(aviso.em).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    notificarWindows(
      titulo,
      aviso.tipo === "queda"
        ? `A captura de conversas foi interrompida às ${quando}. Abra o Lume para conferir a conexão.`
        : `A captura de conversas foi retomada às ${quando}.`,
    );
  };
}

export function avisoWebhook(url, fetchImpl = fetch) {
  return async (aviso) => {
    const r = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(aviso),
    });
    if (!r.ok) throw new Error(`webhook respondeu ${r.status}`);
  };
}

/** Manda para varios canais; a falha de um nao cala os outros. */
export function todos(...canais) {
  return async (aviso) => {
    const erros = [];
    for (const canal of canais) {
      try {
        await canal(aviso);
      } catch (e) {
        erros.push(String(e));
      }
    }
    if (erros.length === canais.length) throw new Error(`nenhum canal de aviso funcionou: ${erros.join("; ")}`);
  };
}
