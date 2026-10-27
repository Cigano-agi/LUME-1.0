import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';

const NOME_MIGRACAO=/^\d{3}-[a-z0-9-]+\.sql$/;

// O cliente HTTP do Neon executa uma consulta por item da transação. A divisão
// respeita strings, identificadores, comentários e blocos dollar-quoted.
export function separarComandosSql(conteudo){
  if(typeof conteudo!=='string')throw new Error('Migração SQL inválida.');
  const comandos=[];
  let atual='',estado='normal',temSql=false,profundidade=0,delimitador='';
  for(let i=0;i<conteudo.length;i++){
    const c=conteudo[i],par=conteudo.slice(i,i+2);
    if(estado==='linha'){
      atual+=c;
      if(c==='\n')estado='normal';
      continue;
    }
    if(estado==='bloco'){
      if(par==='/*'){atual+=par;i++;profundidade++;continue;}
      if(par==='*/'){atual+=par;i++;if(--profundidade===0)estado='normal';continue;}
      atual+=c;continue;
    }
    if(estado==='aspas'||estado==='identificador'){
      const fim=estado==='aspas'?"'":'"';
      if(c===fim&&conteudo[i+1]===fim){atual+=fim+fim;i++;continue;}
      atual+=c;
      if(c===fim)estado='normal';
      continue;
    }
    if(estado==='dolar'){
      if(conteudo.startsWith(delimitador,i)){atual+=delimitador;i+=delimitador.length-1;estado='normal';}
      else atual+=c;
      continue;
    }
    if(par==='--'){atual+=par;i++;estado='linha';continue;}
    if(par==='/*'){atual+=par;i++;profundidade=1;estado='bloco';continue;}
    if(c==="'"){atual+=c;temSql=true;estado='aspas';continue;}
    if(c==='"'){atual+=c;temSql=true;estado='identificador';continue;}
    if(c==='$'){
      const marca=/^(?:\$\$|\$[A-Za-z_][A-Za-z0-9_]*\$)/.exec(conteudo.slice(i))?.[0];
      if(marca){atual+=marca;i+=marca.length-1;delimitador=marca;temSql=true;estado='dolar';continue;}
    }
    if(c===';'){
      if(temSql)comandos.push(atual.trim());
      atual='';temSql=false;continue;
    }
    atual+=c;
    if(!/\s/.test(c))temSql=true;
  }
  if(!['normal','linha'].includes(estado)||temSql)throw new Error('Migração SQL incompleta ou sem ponto e vírgula final.');
  if(!comandos.length)throw new Error('Migração SQL vazia.');
  return comandos;
}

export async function migrarCentral({sql,pasta=new URL('../central/migrations/',import.meta.url)}={}){
  if(typeof sql?.query!=='function'||typeof sql?.transaction!=='function')throw new Error('Cliente Neon inválido.');
  const nomes=(await readdir(pasta)).filter(nome=>NOME_MIGRACAO.test(nome)).sort();
  if(!nomes.length)throw new Error('Nenhuma migração encontrada.');
  await sql.query('CREATE TABLE IF NOT EXISTS lume_schema_migrations (nome varchar(160) PRIMARY KEY, checksum char(64) NOT NULL, aplicada_em timestamptz NOT NULL DEFAULT now())',[]);
  const aplicadas=await sql.query('SELECT nome,checksum FROM lume_schema_migrations',[]);
  const porNome=new Map(aplicadas.map(item=>[item.nome,item.checksum]));
  let novas=0;
  for(const nome of nomes){
    const conteudo=await readFile(new URL(nome,pasta),'utf8');
    const checksum=createHash('sha256').update(conteudo).digest('hex');
    if(porNome.has(nome)){
      if(porNome.get(nome)!==checksum)throw new Error(`Migração alterada após aplicação: ${nome}`);
      continue;
    }
    const comandos=separarComandosSql(conteudo);
    await sql.transaction([
      ...comandos.map(comando=>sql.query(comando,[])),
      sql.query('INSERT INTO lume_schema_migrations(nome,checksum) VALUES($1,$2)',[nome,checksum])
    ]);
    novas++;
  }
  return {total:nomes.length,novas};
}
