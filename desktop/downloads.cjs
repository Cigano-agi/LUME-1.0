// Renderer downloads are limited to our window, blob origin and known export/package names.
function downloadPermitido({janelaCorreta,url,nome,origem}) {
  if(janelaCorreta!==true||typeof url!=='string'||typeof origem!=='string'||typeof nome!=='string')return false;
  if(url.startsWith(`blob:${origem}/`))return /^assessor-(?:projeto|exportacao|backup|feedback)-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.json$/.test(nome)
    || /^Lume-[0-9A-Za-z.-]+\.mcpb$/.test(nome);
  const prefix=`${origem}/api/v3/dados/backup-v10/arquivo?ticket=`;
  return /^lume-backup-\d{4}-\d{2}-\d{2}\.lumebak$/.test(nome)
    && url.startsWith(prefix)&&/^[a-f0-9]{64}$/.test(url.slice(prefix.length));
}
module.exports={downloadPermitido};
