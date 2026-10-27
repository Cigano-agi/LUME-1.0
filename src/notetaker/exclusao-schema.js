import { createHash } from 'node:crypto';
import { CATALOGO_V9 } from '../backup-acervo-catalogo.js';
import { CATALOGO_V10 } from '../backup-acervo-catalogo-v10.js';
import { DDL_V9 } from '../backup-acervo-schema-manifest-v9.js';
import { NOMES_OBJETOS_CONTROLE_EXCLUSAO, validarControleExclusao } from './exclusao-controle.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hashSql = value => createHash('sha256').update(String(value)).digest('hex');
const fail = () => { throw Object.assign(new Error('Schema de exclusão desconhecido.'), { code: 'INTEGRIDADE' }); };
const ETAPAS_V10=CATALOGO_V10.find(x=>x.nome==='etapas');
const CICLO_MIDIAS_V10=CATALOGO_V10.find(x=>x.nome==='ciclo_midias');
const FILA_RETOMADA_V10=CATALOGO_V10.find(x=>x.nome==='wa_fila_retomada');
const DDL_ETAPAS=Object.freeze([
  '940b0ccc58ab5e9957ac7d36adc8a47db596021bd6f02a996866a54b7cb5fda0',
  '50dbe806a7221473c5be0168e3567b10877c076a5c42ba16380f9c1c8fb3871b',
  'f8d08bf6b2b77df8b2705cd6dbec71243b7b96dd6fd396a04d86d5968f32ef94'
]);
const DDL_CICLO_MIDIAS='3810769c5d31197ad5ecb9f40b01b00477d0ad45221cc069e5499080c0ffa635';
const FKS_CICLO_MIDIAS=[[0,0,'eventos','evento_id','id','NO ACTION','CASCADE','NONE']];
const INDEXES_CICLO_MIDIAS=[['sqlite_autoindex_ciclo_midias_1','u',0,null,
  [[0,null,'caminho',0,'BINARY',1],[1,-1,null,0,'BINARY',0]]]];
const FKS_FILA_RETOMADA=[[0,0,'wa_interrupcoes','interrupcao_id','id','NO ACTION','CASCADE','NONE']];
const INDEXES_FILA_RETOMADA=[['sqlite_autoindex_wa_fila_retomada_1','pk',0,null,
  [[0,null,'interrupcao_id',0,'BINARY',1],[1,null,'conversa_id',0,'BINARY',1],[2,-1,null,0,'BINARY',0]]]];
const PK_EXCLUSAO = Object.freeze({
  notetaker_sessoes:['id'], notetaker_partes:['id'], notetaker_trechos:['id'], notetaker_fontes:['evento_id'], notetaker_correcoes:['id'],
  eventos:['id'], conversas_app:['id'], priv_vinculos:['fonte_id','derivado_id'], lume_acoes:['id'], lume_acoes_historico:['id'],
  lume_execucao_contextos:['id'], lume_execucao_contexto_guardas:['contexto_id'], lume_execucao_contexto_grants:['execucao_id'],
  lume_execucoes:['id'], lume_execucao_eventos:['id'], desktop_tarefas_sugestoes:['id'], desktop_tarefas_fontes:['sugestao_id','evento_id'],
  itens_crm:['id'], rascunhos:['id'], desktop_negocios:['id'], desktop_negocios_historico:['negocio_id','revisao'],
  lume_projetos_comerciais:['id'], lume_projetos_fontes:['id'], lume_projetos_historico:['id'], lume_comandos:['id'],
  lume_comando_tarefas:['id'], lume_comando_lembretes:['id'], lume_tags_entidades:['tag_id','entidade_tipo','entidade_id','comando_id'],
  lume_tags:['id'], transcricoes:['id'], eventos_financeiros:['id'], desktop_tarefas_analises:['evento_id'], etapas:['evento_id','etapa'],
  desktop_vetores:['evento_id','pedaco'], f10_procedencias:['evento_id','fingerprint','pacote_id','projeto_id'],
  lume_ciclo_importacoes:['tabela','registro_id'], lume_projetos_importados_guardas:['fonte_id'], lume_projetos_revisoes:['evento_id'],
  lume_laya_fila:['evento_id'], caixas_jobs:['id'], wa_recuperacoes:['id'], wa_fila_retomada:['interrupcao_id','conversa_id'], lume_vendas_avaliacoes:['id']
});
const triggerHashes = Object.freeze({
  ciclo_importacao_remove_lume_execucao_contextos:'e00996da7ef7f9dc357127545ae0691ef73333f6408df36b27572b2faf9e5d01',
  ciclo_importacao_remove_lume_execucao_eventos:'e311d080f216e264b700fc0283b8608babc0572b0fd4b8db3fba07dd25445fa8',
  ciclo_importacao_remove_lume_execucoes:'507d3be7e4846cbb0107c9c87ca112ec843993005e33fed48632808875a3be46',
  ciclo_importacao_remove_lume_projetos_comerciais:'9a601bfa67e87e97452b83fe2e57fb9c6580c1ca5dd037c9295e447904798321',
  ciclo_importacao_remove_lume_projetos_fontes:'ed6554238a29fdbf444326b9d27e0a8777c70f29fa9b86597318a99cf4077abb',
  ciclo_importacao_remove_lume_projetos_historico:'28ddc1f8aab89aa80b47b5936202f6324a86af0329e6e83d5b2a2387e2641397',
  ciclo_importacao_remove_lume_vendas_avaliacoes:'cf2cb820c92e2b7ed122a1cfa3b7ff362915a5c8a411feb88858819408a6cb62',
  ciclo_importacao_remove_wa_cobertura:'594b8a732245bd5e9d92db68969f8178ce91b00fb23ae588debccc44371eae35',
  ciclo_importacao_remove_wa_interrupcoes:'f875adb65a1811c54fec4850f02b4fbe97b8c9e24741bb4cc28746c982393531',
  ciclo_importacao_remove_wa_recuperacoes:'e24147747a748566a162d23dec7d19c2184846a125492924b96e6d2e24f40da6',
  ciclo_importacao_remove_wa_retomadas:'2cc9c84d83c38fec2dce7d1f9a4413eaf5561300ecb9a416fc136fabbd4da3ba',
  lume_vendas_fonte_removida:'9ecdb305cc729cf0d9dd4bbdcea44a8fcc8ec10f9c372a1a7e774d278e983b58',
  lume_vendas_revisao_eventos_delete:'21d46d648ccf9165bc9a01dfdd34a39e4079833f6e7fc203efe205628fc2b08b',
  lume_vendas_revisao_eventos_insert:'6b0cd5f5fbc2ba03112af1c7196fdec8e7b9801f7a657bd6c4fefdec18b903a3',
  lume_vendas_revisao_eventos_update:'f0e19eb2c4ed999c77d926c4a6598397a5f573855e55472f0e46a33dfd367eb3',
  lume_vendas_revisao_f10_procedencias_delete:'32d841c4a731f5706ed925a45057258646bdfed633a9917400d3a2c2859ea86d',
  lume_vendas_revisao_f10_procedencias_insert:'393e1ac69c3c77f38bd1c1047bca28e352c435fafb3f409d3bce5f054f2789c4',
  lume_vendas_revisao_f10_procedencias_update:'998cb96330f4bc3126607163852ece2485bc27152dd78dba9c616aecd1f2cd72',
  lume_vendas_revisao_politicas_conversa_delete:'369a0668952a4f4a3f8e6b8ad83b7acc5d847e7e4b7f4429a856d09d2bdcfc2d',
  lume_vendas_revisao_politicas_conversa_insert:'d15fd24ba78ef44dac054e40cc5e56680605e9638c3902f12c50ec50c08d0b5b',
  lume_vendas_revisao_politicas_conversa_update:'7b8fc6b18ca9750a65ad29dca525e282ba4d9f69e75f0f7f308fd981387bae63',
  lume_vendas_revisao_transcricoes_delete:'0455adcf9419f7c5e992d9a399b9702cb7f0ae0a51f32fbaae868f245a363797',
  lume_vendas_revisao_transcricoes_insert:'74d8cd3ca2811f0866b4ced2f88bb266dc4a45bed0b9728e392f98d765e20ade',
  lume_vendas_revisao_transcricoes_update:'cdff95ce21933f5e19aa61eea0fb7dde7478f99e212a3fed8b1ab5ad75eaf089',
  wa_recuperacao_removida:'6f6f528d1a0342e8edf9d4bfb649e288694aa2169740f5aa97b5822bfa0ed2bf',
  wa_fila_retomada_removida:'14800d31f4f3fb68c4c2be97f0c0410c42bffd5a0c651f69bfc636e97e346600',
  desktop_vetores_update:'fe611e026df36c41316c141cb18ed0156710eb3d373b30fd3e3b39010c3a7320',
  desktop_transcricao_vetores_ai:'b80dffd7a459cee59459686d4e22451ed700a7b1be647969a1f4603bfcf1cd69',
  desktop_transcricao_vetores_ad:'68fadc39fb225ff0dbcffaabad30fd8739c4fc1a16d555f42bf8113f6c5e7970',
  desktop_transcricao_vetores_au:'ad631fd7f4bf2471b548edb505a14faf75ef5b7b8b58009b0fe4ccdf66e85e3c',
  desktop_fontes_ai:'793a3ab33a3d511caedfeb04cb5917e9ddad711eea8dbfd1f4aea177b7f879ba',
  desktop_fontes_ad:'a70e5bda11b6d23cf8e5c253cd758968d21575ae2863b7cebb3e860fcdb9f67b',
  desktop_fontes_bu:'c0edef426e6cbe94c9b40008b4ebd3ebfc1b3903453772a6c902a2e4b38764e7',
  desktop_fontes_au:'ac95791ff4c400877ff3607415b6eb261a5e212ba0354ef29d728fde33ae8416',
  desktop_transcricao_fts_ai:'653c27e601b8937fe5b11434c691ed84964291b6ee55a43d28ea79df565827a7',
  desktop_transcricao_fts_bd:'b7ad577ffa9e777350fbdaba5e01f89fef4d8ce531ed4f053c47c4e6355ebfa2',
  desktop_transcricao_fts_ad:'7139383bfa24adb03d876bc38d7907d06dff1e02dfc9b80d0ccf614666b6eb17',
  desktop_transcricao_fts_bu:'74e25b7dbf105eca582bc487c5c274fa1fd2b2059d0991e55f17a88277b2bbf6',
  desktop_transcricao_fts_au:'b76ea50d0a256908886e8f679f6edec9517961a1b2a9da4536b27750dda7657b',
  lume_projetos_evento_apagado:'c8d1ab56c5b253dafef4765b7daf1398b4ce04eb706ea20b529a56846f89643b',
  lume_projetos_evento_alterado:'b77410331ec1943e1d33c7a00e8dee7f76c46e7614bad11f456fd0c0ba5631f9',
  lume_projetos_politica_alterada:'483573fe9e33f73357c57964f442f5b19a621da009fec977c33d2fc869492590',
  lume_projetos_politica_apagada:'4d4ff75cbf1d0902dc60610a4900a300de8a6b0532495910f5f3f0bbc75fd5bc',
  lume_projetos_procedencia_alterada:'903e49347256a3edf39a00a9a9b467330aaa6cc0ac4557cbee663a366f76ba79',
  lume_projetos_procedencia_apagada:'30c6256b92c76e43a76612237830297a49052d9d2e56ecf65b4c94fd86ce7d34',
  lume_projetos_revisao_evento:'9ca7392c6b1a00fd72dcf8de48ea3dfac881f89db3d44fda3e0af53deae09a85',
  lume_projetos_transcricao_alterada:'0fd6c888c5cd1c5a53f1024c0f4192663e6c049d195e23e09c2c55f70bae8bc5',
  lume_projetos_transcricao_apagada:'a514b209ff0885c4a4e514cde84d4beb2a65f88f715103d3e6e81ec2eec964cc',
  lume_projetos_transcricao_inserida:'0b55ea0a4d9769d53c18cb29bee42ff06bca7c82e6f2734b64353d47a802c66b',
  lume_projetos_revisao_transcricao_delete:'fe504bcd4ffe28be6e688f65bf91afc5deb49ef6c00dd35dceb1c82b2e24aa0a',
  lume_projetos_revisao_transcricao_insert:'52039b371be60ecc0a70e657e34ec97b69dfb258707c95d023eeb7f161450b32',
  lume_projetos_revisao_transcricao_update:'28740ab8250926ca373c51f63347b532344a86a43d008cf940e26f315e3aae1c',
  lume_projetos_revisao_acao_alterada:'53a37da89826552d809e62219643598767c97be6423a04a07fce7ffc79eadaad',
  lume_projetos_revisao_acao_apagada:'cc9f7520aa1cbbff4cdd3dddb17bd261e4895cc0ccc3218cfddcf8b380c785e0',
  lume_projetos_revisao_organizar_delete:'f34391dbbe7200157bf0f3862162fc581616cec1da794156a5b2e1c7be775d5e',
  lume_projetos_revisao_organizar_update:'a690769deaa023c8485d7899923c1c2ab399f8241bb78a2646313c7ba2bd79bf',
  lume_projetos_revisao_politica_update:'5740a75ad95d9acc6634c1775ade15e8390f74a96d67f4f61e0a6a80fb7e2902',
  lume_projetos_revisao_politica_delete:'712a9b10a6a6bc3163c7450e2371abcc72977944e5e1c4fa6d6f68f7f260b15c',
  lume_projetos_revisao_procedencia_update:'bc9bf8e2bab4e5ac32fd045efa78522cd6e5316038a38afd299fcb18284da4ab',
  lume_projetos_revisao_procedencia_delete:'e06d6166f074853e7d4038276ceb9f78121c4249089421f0d171021308b8d921',
  lume_projetos_importados_inserida:'d2cdddcc9ec07e67d721a5d8eaa721266ae7138b72613e8d508191555d6f0b14',
  lume_projetos_importados_alterada:'e2ea94c2ccce5d7bfe3b0873fd372d97db8356125b41607c39b692c0a278d1dc',
  lume_projetos_importados_projeto:'ac65996f1cebf37335a054578ef43f6eef5c3e02e9741fda83567c7a9c1ae95a',
  lume_execucao_grant_revogada:'b46c98351bc4789fb5ba156644d014a221f3fa5f39c1fb4b49ef5de754ece2c5',
  lume_execucao_grant_politicas_conversa_INSERT:'77a0a72708d53ca7184dca39e55b5309ccb1be52e86cc85e719662506f3e6c58',
  lume_execucao_grant_politicas_conversa_UPDATE:'5561c2322d7db1dc6fb3ed60be07206bce3136bd0f0b3179ae7eb0557561da84',
  lume_execucao_grant_politicas_conversa_DELETE:'e1234adf58fa849261368fae6234896abbf822435712c70453aa05ea5196a4c2',
  lume_execucao_grant_lume_acoes_conversas_INSERT:'8f1a9741c460307739b60d2385adc3dd034cd67355e40d928242eb8aaee0d72c',
  lume_execucao_grant_lume_acoes_conversas_UPDATE:'28c206580fd35eef8d19e4d666258a70ab1fd40ac807dc3fddd1294cb90940cb',
  lume_execucao_grant_lume_acoes_conversas_DELETE:'a353c5d5d432f486ad9fad5044e1e8dbeb9c23a37df496ce52dd434ffc6e4d5c',
  lume_execucao_grant_f10_procedencias_INSERT:'bc7482aa35dc6fa9eae7cced1f22c8ae9a3a4d491a60250b8dd6405531ffb2b5',
  lume_execucao_grant_f10_procedencias_DELETE:'8427c73072ebdb6e25b937f9f3ab4230c91e61aed82731fe54fd36e081965918',
  lume_execucao_grant_f10_procedencias_UPDATE:'2169f7912a4b627d2cc9a1883f4f5770ab73a1ca46a6fa2779277edc6f1046ac',
  lume_execucao_grant_lume_acoes_UPDATE:'05888317b12c1c9ab80571d581278ac669dbd3bc9bb1bbc76e691146c64adf35',
  lume_execucao_grant_eventos_UPDATE:'4520a98649d5df1e35b56246c5562b97292739f4466ea4d2ac609bc1097e7976',
  lume_execucao_grant_transcricoes_DELETE:'dbae91f06d000850a1eebeecb5718779276baa1ef5cfe47f19710ec0465bf3de',
  lume_execucao_grant_transcricoes_INSERT:'73b15deea04d375259e2bc7f053ed679464538fbdc748d38a5d582ff62d64109',
  lume_execucao_grant_transcricoes_UPDATE:'a2f08dd094429d5d68925b55f4ffdac16d64ef1c3f50d8b12cd76c44ca3de81f',
  lume_execucao_guarda_snapshot_UPDATE:'10439d959af1d1944246562335588aa952c4c71b23eeed04c0ced280ad309f29',
  lume_execucao_guarda_fonte_DELETE:'e6b8a17ef2c7d16ccf0c40aa7d2f5dfe8175cbbec8710b5fe62b3f8354cfa8d9'
});
// Fixed fingerprints of the C0-relevant table DDL from the reviewed constructors.
// The structural v9 manifest below is also checked for columns, PKs, FKs and UNIQUE indexes.
const tableDdlHashes=Object.freeze({
  wa_fila_retomada:'0fa05ee27ddf486bf710b4fc5a6179d55902287c90b40070b160f67718971a01',
  eventos:'e067b74c2fa22dc5cb4d67517b6e1257c8235bdd88b86160dba50bdc3af05867',
  etapas:'940b0ccc58ab5e9957ac7d36adc8a47db596021bd6f02a996866a54b7cb5fda0',
  f10_procedencias:'cc0f220e459a5f528163e9f90f6ca23182c4a1e2bdb6446580ea03925d70db1f',
  priv_vinculos:'7d03b43362874892f913f5e2221d5a3d39de57c3ac8f152b8b7539bcf442eb7d',
  notetaker_sessoes:'91a417af8428e7fbad1fbf23bcb12b566bd2a06067b4a12fb7c27a3635d6ee09',
  notetaker_partes:'6da5ae426a14bd0c0d99d766adb466d439977507ee42ab675158ff08ddb50ac0',
  notetaker_trechos:'460b8b27f6468036881de302c9b58723c181544baf8a4a6e1b010a6d298598fc',
  notetaker_fontes:'8b99ed7cf206d9ec467d79da9b85fb2e3213ab6f96fd5ec28cd5557d1047f0f7',
  notetaker_correcoes:'4acbbc3d60391e3b5fef9a785e33625373be732955d13cbb362ed7c7fa382020',
  lume_comandos:'261977e6b59b3500b1d122eb7752bebc78a53e64fa744136f41414719818f8c1',
  lume_tags:'6e1c8d3bbbe9e046fc3791d9ff4601c14ab74276732460d8a07b34033db90910',
  lume_tags_entidades:'05289be1fe347965a6f5ee364ad2e252c5573ba613d4dd4703094e7e3710ba75',
  lume_comando_tarefas:'508e79e9a47709575783c45e57c1f6a1f7e57591278a59bba36ae8be76900b2b',
  lume_comando_lembretes:'4b7c1453a6d6f870c6342f80a75c850159813c82111bd471bbfcffd9b1600028',
  itens_crm:'be9fdf7cfdc4750b6cd6bff3f6efcab01aff1d3e2a4afef12404f2413146665a',
  desktop_tarefas_analises:'76f3927e91738e5bc48f9531b3aaba3bd35617257ba062a6f85ada79b1c7a015',
  desktop_tarefas_sugestoes:'01cb83f818d0ff870d34763c05bbab9c6f49bc8e99bde382b25a8062f21312a2',
  desktop_tarefas_fontes:'9bb2f2527b462315a852d734bcf30448c13bd2377f06fad55c45d25e3d1c3318',
  desktop_negocios:'5b0f6c79f94282d3085eb366039dbea2a270edfab71a47fd51b8268b4098bbb7',
  desktop_negocios_historico:'2315420610c42f33dbc701f67584822248ba6448b729dafa9f2aa2453324c6a5',
  lume_projetos_comerciais:'1609abc1ca5d0897bb06bce4c92fa3954449beb285ef798055ed23a09b93ec83',
  lume_projetos_fontes:'9cdc29b1baab23da8e8ec11442ba67b097ce61961a8446af4ebcb9161737145a',
  lume_projetos_historico:'052be0eb78db45572796c9360613b9c339c5c3f3646044b5794c2fc13f3c2c7d',
  lume_projetos_revisoes:'47184323e8d69de17d87269c8fda1a05a49c303491cc6783c7f66c5136a9aaf8',
  lume_projetos_importados_guardas:'5ccd16e0932608506de9a63d8b4d0ca4cf4b2d48ca27d82384f61941134d512f',
  lume_acoes:'0bde98961c5a7ea8c260a0637e47e9a6e928227d4a8f9988372d002568ccc377',
  lume_acoes_historico:'981c0363370b95281c3afcec768d2e0bca1d3c32bea014fadbd928edf6f85341',
  lume_execucao_contextos:'441061dcddd3f3b031bf7fab6a10dd8c418639254b9052cd9b0366881d44b44d',
  lume_execucoes:'179255876374ee16f00cc20cf1395bb95a748df259804cf4aa07e364c6d0cd2e',
  lume_execucao_eventos:'f788c178bcae8064a10850c83584cfe58bf3b3079724be0d78675da49abe9605',
  lume_execucao_contexto_grants:'cd80983353f92a0bdcbbf99ed72d60b7b0ce21442e6cc1dd56891ef6012342e0',
  lume_execucao_contexto_guardas:'ed5f7eac35e93aef2156dc7063b3753fa6265d0b62f0648b16848a56c9c88e6b'
});
// Preserve literals, quoting and whitespace: the fingerprints represent the
// exact compiled schema definitions reviewed for this C0 boundary.
const normalizeSql = sql => String(sql ?? '');
const q = name => `"${String(name).replaceAll('"','""')}"`;
const requiredTriggerGroups = Object.freeze([
  ...[
    'lume_execucao_contextos','lume_execucao_eventos','lume_execucoes','lume_projetos_comerciais','lume_projetos_fontes',
    'lume_projetos_historico','lume_vendas_avaliacoes','wa_cobertura','wa_interrupcoes','wa_recuperacoes','wa_retomadas'
  ].map(table=>Object.freeze({when:p=>p.has(table)&&p.has('lume_ciclo_importacoes'),names:[`ciclo_importacao_remove_${table}`]})),
  {when:p=>p.has('lume_vendas_avaliacoes'),names:['lume_vendas_fonte_removida']},
  ...['eventos','f10_procedencias','politicas_conversa','transcricoes'].map(table=>Object.freeze({
    when:p=>p.has('lume_vendas_revisoes')&&p.has(table),names:['delete','insert','update'].map(action=>`lume_vendas_revisao_${table}_${action}`)
  })),
  {when:p=>p.has('wa_recuperacoes'),names:['wa_recuperacao_removida']},
  {when:p=>p.has('wa_fila_retomada'),names:['wa_fila_retomada_removida']},
  { when: p => p.has('desktop_fontes_fts'), names: ['desktop_fontes_ai','desktop_fontes_ad','desktop_fontes_bu','desktop_fontes_au'] },
  { when: p => p.has('desktop_fontes_fts') && p.has('transcricoes'), names: ['desktop_transcricao_fts_ai','desktop_transcricao_fts_bd','desktop_transcricao_fts_ad','desktop_transcricao_fts_bu','desktop_transcricao_fts_au'] },
  { when: p => p.has('desktop_vetores'), names: ['desktop_vetores_update'] },
  { when: p => p.has('desktop_vetores') && p.has('transcricoes'), names: ['desktop_transcricao_vetores_ai','desktop_transcricao_vetores_ad','desktop_transcricao_vetores_au'] },
  { when: p => p.has('lume_projetos_comerciais'), names: [
    'lume_projetos_evento_apagado','lume_projetos_evento_alterado','lume_projetos_politica_alterada','lume_projetos_politica_apagada',
    'lume_projetos_procedencia_alterada','lume_projetos_procedencia_apagada','lume_projetos_importados_inserida',
    'lume_projetos_importados_alterada','lume_projetos_importados_projeto','lume_projetos_revisao_evento',
    'lume_projetos_revisao_politica_update','lume_projetos_revisao_politica_delete',
    'lume_projetos_revisao_procedencia_update','lume_projetos_revisao_procedencia_delete'
  ] },
  { when: p => p.has('lume_projetos_comerciais') && p.has('transcricoes'), names: [
    'lume_projetos_transcricao_alterada','lume_projetos_transcricao_apagada','lume_projetos_transcricao_inserida'
  ] },
  { when: p => p.has('lume_projetos_revisoes') && p.has('transcricoes'), names: [
    'lume_projetos_revisao_transcricao_delete','lume_projetos_revisao_transcricao_insert','lume_projetos_revisao_transcricao_update'
  ] },
  { when: p => p.has('lume_projetos_revisoes') && p.has('lume_acoes'), names: [
    'lume_projetos_revisao_acao_alterada','lume_projetos_revisao_acao_apagada'
  ] },
  { when: p => p.has('lume_projetos_revisoes') && p.has('lume_acoes_conversas'), names: [
    'lume_projetos_revisao_organizar_delete','lume_projetos_revisao_organizar_update'
  ] },
  { when: p => p.has('lume_execucao_contexto_grants'), names: [
    'lume_execucao_grant_revogada','lume_execucao_grant_politicas_conversa_INSERT','lume_execucao_grant_politicas_conversa_UPDATE',
    'lume_execucao_grant_politicas_conversa_DELETE','lume_execucao_grant_lume_acoes_conversas_INSERT',
    'lume_execucao_grant_lume_acoes_conversas_UPDATE','lume_execucao_grant_lume_acoes_conversas_DELETE',
    'lume_execucao_grant_f10_procedencias_INSERT','lume_execucao_grant_f10_procedencias_DELETE',
    'lume_execucao_grant_f10_procedencias_UPDATE','lume_execucao_grant_lume_acoes_UPDATE',
    'lume_execucao_grant_eventos_UPDATE','lume_execucao_guarda_snapshot_UPDATE','lume_execucao_guarda_fonte_DELETE'
  ] },
  { when: p => p.has('lume_execucao_contexto_grants') && p.has('transcricoes'), names: [
    'lume_execucao_grant_transcricoes_DELETE','lume_execucao_grant_transcricoes_INSERT','lume_execucao_grant_transcricoes_UPDATE'
  ] }
]);

function indexes(db,name) {
  return db.prepare(`PRAGMA index_list(${q(name)})`).all().filter(x=>x.unique).map(x=>[
    x.name,x.origin,x.partial,db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(x.name)?.sql??null,
    db.prepare(`PRAGMA index_xinfo(${q(x.name)})`).all().map(i=>[i.seqno,i.cid>=0?null:i.cid,i.name,i.desc,i.coll,i.key])
  ]).sort((a,b)=>a[0].localeCompare(b[0]));
}

export function validarSchemaExclusao(db) {
  validarControleExclusao(db);
  const objects=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()
    .filter(x=>!NOMES_OBJETOS_CONTROLE_EXCLUSAO.includes(x.name));
  const catalog=new Map(CATALOGO_V9.map(x=>[x.nome,x]));
  // v9 permanece imutável. A exclusão reconhece só os esquemas de fila e
  // mídia nativa explicitamente aprovados, inclusive o v10 vindo de ALTER.
  catalog.set('ciclo_midias',CICLO_MIDIAS_V10);
  catalog.set('wa_fila_retomada',FILA_RETOMADA_V10);
  const aux=DDL_V9.auxiliares;
  const tableList=db.prepare('PRAGMA table_list').all().filter(x=>x.schema==='main'&&
    !['sqlite_schema','sqlite_sequence'].includes(x.name)&&!NOMES_OBJETOS_CONTROLE_EXCLUSAO.includes(x.name));
  for(const obj of tableList){
    const expected=catalog.has(obj.name)?'table':aux[obj.name]?.[0];
    if(!expected||obj.type!==expected)fail();
    const cols=db.prepare(`PRAGMA table_info(${q(obj.name)})`).all().map(c=>c.name);
    const expectedCols=obj.name==='etapas'&&cols.length===ETAPAS_V10.colunas.length
      ? ETAPAS_V10.colunas : catalog.get(obj.name)?.colunas??aux[obj.name][1];
    if(cols.length!==expectedCols.length||cols.some(c=>!expectedCols.includes(c)))fail();
    const entry=catalog.get(obj.name);
    if(entry?.decisao==='I'){
      const actual=db.prepare(`PRAGMA table_info(${q(obj.name)})`).all().filter(c=>c.pk>0).sort((a,b)=>a.pk-b.pk).map(c=>c.name);
      if(JSON.stringify(actual)!==JSON.stringify(entry.pk))fail();
    }
    if(PK_EXCLUSAO[obj.name]){
      const actual=db.prepare(`PRAGMA table_info(${q(obj.name)})`).all().filter(c=>c.pk>0).sort((a,b)=>a.pk-b.pk).map(c=>c.name);
      if(JSON.stringify(actual)!==JSON.stringify(PK_EXCLUSAO[obj.name]))fail();
    }
    const fks=db.prepare(`PRAGMA foreign_key_list(${q(obj.name)})`).all().map(c=>[c.id,c.seq,c.table,c.from,c.to,c.on_update,c.on_delete,c.match]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
    if(JSON.stringify(fks)!==JSON.stringify(obj.name==='ciclo_midias'?FKS_CICLO_MIDIAS:obj.name==='wa_fila_retomada'?FKS_FILA_RETOMADA:(DDL_V9.foreignKeys[obj.name]??[])))fail();
    if(entry&&JSON.stringify(indexes(db,obj.name))!==JSON.stringify(obj.name==='ciclo_midias'?INDEXES_CICLO_MIDIAS:obj.name==='wa_fila_retomada'?INDEXES_FILA_RETOMADA:(DDL_V9.uniqueIndexes[obj.name]??[])))fail();
    const ddlHash=tableDdlHashes[obj.name];
    const actualDdl=hashSql(normalizeSql(db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(obj.name)?.sql));
    const permittedDdl=obj.name==='etapas'?DDL_ETAPAS:obj.name==='ciclo_midias'?[DDL_CICLO_MIDIAS]:ddlHash?[ddlHash]:null;
    if(permittedDdl&&!permittedDdl.includes(actualDdl))
      throw Object.assign(new Error(`Schema de exclusão desconhecido: ${obj.name}.`),{code:'INTEGRIDADE'});
  }
  for(const object of objects.filter(x=>x.type==='trigger')){
    const expected=triggerHashes[object.name];
    if(!expected||hashSql(normalizeSql(object.sql))!==expected)
      throw Object.assign(new Error(`Trigger de exclusão desconhecido: ${object.name} (${hashSql(normalizeSql(object.sql))}).`),{code:'INTEGRIDADE'});
  }
  const present=new Set(tableList.map(x=>x.name));
  const requiredTriggers=requiredTriggerGroups.filter(group=>group.when(present)).flatMap(group=>group.names);
  const presentTriggers=new Set(objects.filter(x=>x.type==='trigger').map(x=>x.name));
  const missingTrigger=requiredTriggers.find(name=>!presentTriggers.has(name));
  if(missingTrigger)throw Object.assign(new Error(`Schema de exclusão desconhecido: trigger obrigatório ausente (${missingTrigger}).`),{code:'INTEGRIDADE'});
  return hash({
    objects:objects.map(x=>[x.type,x.name,x.tbl_name,normalizeSql(x.sql)]),
    foreignKeys:tableList.map(x=>[x.name,db.prepare(`PRAGMA foreign_key_list(${q(x.name)})`).all().map(f=>[f.id,f.seq,f.table,f.from,f.to,f.on_update,f.on_delete,f.match])]),
    primaryKeys:Object.entries(PK_EXCLUSAO).map(([name,columns])=>[name,columns])
  });
}

export { PK_EXCLUSAO };
