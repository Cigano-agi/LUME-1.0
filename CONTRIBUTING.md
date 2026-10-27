# Contribuir com o Lume

O trabalho começa no [estado da entrega](DONE.md) e no [contrato atual](docs/lume-1/CONTRATO.md). Leia [AGENTS.md](AGENTS.md) antes de editar. Preserve alterações existentes e combine a propriedade dos arquivos quando houver trabalho paralelo.

## Preparar e verificar

Use Node.js 24 ou superior. Na raiz do repositório, `npm ci` instala as dependências fixadas no lock e executa o hook local de preparação; `npm test` roda a suíte Node. No PowerShell, `npm.cmd` evita depender do atalho de script. Não troque políticas do sistema para fazer um comando passar.

Escolha também os testes dirigidos ao comportamento alterado. Para uma falha, registre a reprodução, corrija a causa e repita a verificação. Para interface, confira o percurso e a renderização em ambiente isolado, com fixture identificada. Um teste verde de componente não substitui revisão independente nem prova do aplicativo instalado.

`npm run desktop` e `npm run test:desktop` abrem Electron. Confira os pré-requisitos e o perfil antes de executá-los. O perfil normal é `AssessorDesktop`; não o trate como fixture ou diretório descartável.

## Preparar uma mudança revisável

- Descreva o problema, o comportamento resultante e o limite da alteração.
- Preserve fontes, autorizações, correções manuais e a diferença entre informado, verificado, enviado e aceito.
- Inclua comandos e resultados efetivamente observados. Registre verificações que não foram executadas.
- Mantenha dados reais, credenciais, sessões, bancos e screenshots pessoais fora do diff.
- Atualize o documento responsável pelo contrato ou fluxo; evite duplicar relatórios em vários índices.

Build, instalação, assinatura, publicação e envio externo possuem escopos próprios. Preparar um artefato não autoriza distribuí-lo. Não substitua manualmente binários ou ASAR para superar uma restrição do sistema.

Os assets em [docs/marketing](docs/marketing/README.md) são apresentação editorial. Não representam provas de qualidade, capturas de dados reais ou anúncio de release.
