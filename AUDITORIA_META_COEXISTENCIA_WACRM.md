# Auditoria técnica — Integração Meta WhatsApp Business e Coexistência no WACRM

| Campo | Valor |
| --- | --- |
| Data da auditoria | 06/11/2026 (America/Sao_Paulo) |
| Repositório | `D:\GitHub\Pessoal\WACRM\wacrm` |
| Base Git | `4d4085ed714678916ed244494cbf857b0b58b968` + working tree não commitado |
| Escopo | Cloud API, Embedded Signup, coexistência WhatsApp Business App + Cloud API, webhooks, histórico, multi-tenancy, banco, segurança e testes |
| Natureza | Auditoria somente-leitura; nenhuma correção funcional, migração, deploy, conexão de número ou alteração de credencial foi executada |
| Artefato produzido | Este relatório Markdown |
| Atualização posterior | Correções autorizadas e aplicadas em 06/11/2026; ver seção L |
| Limite principal | O estado real do aplicativo, portfólio, Tech Provider, permissões, App Review, modo Live e Configuration ID na Meta não pode ser comprovado apenas pelo repositório |

## Legenda de classificação

| Classificação | Significado |
| --- | --- |
| **IMPLEMENTADO E VALIDADO** | Há código e teste automatizado relevante ou verificação determinística executada nesta auditoria. |
| **IMPLEMENTADO, NÃO TESTADO** | O código existe, mas o comportamento não foi comprovado de ponta a ponta. |
| **PARCIALMENTE IMPLEMENTADO** | O requisito é atendido em parte e há lacuna funcional conhecida. |
| **AUSENTE** | Não foi encontrada implementação necessária. |
| **IMPLEMENTAÇÃO INCORRETA** | Há evidência de comportamento incompatível com o requisito ou risco objetivo. |
| **NÃO APLICÁVEL** | O requisito não pertence ao fluxo implementado. |
| **NÃO VERIFICÁVEL LOCALMENTE** | Depende da Meta, do provedor de hospedagem ou de infraestrutura externa. |

Severidade: **P0** bloqueia produção ou é vulnerabilidade crítica; **P1** compromete funcionalidade essencial ou isolamento; **P2** afeta confiabilidade, diagnóstico ou conformidade de forma relevante; **P3** é melhoria de robustez ou manutenção.

## Base auditada

A análise foi feita no working tree, não apenas em `HEAD`. Há alterações não commitadas em:

- `src/app/api/whatsapp/coexistence/route.ts`
- `src/app/api/whatsapp/coexistence/route.test.ts`
- `src/app/api/whatsapp/webhook/route.ts`
- `src/components/settings/whatsapp-coexistence.tsx`
- `src/lib/whatsapp/coexistence.ts`
- `src/lib/whatsapp/coexistence.test.ts`
- `.env.local.example`

Essas alterações atualizam o fluxo para Embedded Signup v5, usam `GET /oauth/access_token`, preservam erros da Meta e adicionam relay opcional de webhooks. As referências de linha deste relatório correspondem ao working tree auditado.

> **Estado do documento:** as seções A–K preservam a fotografia da auditoria original e da árvore encontrada antes das correções. A seção L registra o estado implementado depois da autorização para aplicar as correções.

---

# A. Resumo executivo

O WACRM possui uma integração Cloud API funcional e uma base de coexistência melhor que a média: Embedded Signup v5, troca do código no servidor, validação de `is_on_biz_app` e `platform_type`, token cifrado com AES-256-GCM, HMAC do webhook, roteamento por `phone_number_id` e persistência atômica dos ecos do WhatsApp Business App.

O veredito, porém, é **parcialmente preparado**, não completo:

1. **O fluxo básico de coexistência está implementado**, mas não é uma coexistência completa. O sistema não inicia a sincronização de contatos ou histórico, não processa `history`, `smb_app_state_sync` nem `account_update`, e não trata corretamente usuários identificados apenas por Business-scoped User ID (BSUID).
2. **Mensagens enviadas pelo celular são importadas parcialmente.** Texto, mídia suportada e localização funcionam pelo caminho de `smb_message_echoes`; edição, revogação e mensagens sem número de telefone são descartadas.
3. **O Embedded Signup v5 está tecnicamente correto** no que é auditável: `extras.version = "v5"`, `messaging_account_ids`, `is_on_biz_app`, `GET /oauth/access_token`, token mantido no servidor e chamada a `subscribed_apps`. A aprovação externa do Configuration ID e da conta como Tech Provider continua **não verificável localmente**.
4. **O erro “ML Informática não pode integrar clientes no momento” não existe no repositório** e ocorre antes da seleção do número. Portanto, não há evidência de que ele seja produzido pelo backend WACRM. As causas prioritárias são configuração/eligibilidade externa da Meta, seguidas de variáveis locais incompletas no ambiente auditado.
5. **Há vulnerabilidades relevantes.** O `npm audit --omit=dev` reportou 2 vulnerabilidades críticas, 13 altas, 8 moderadas e 1 baixa; `next@16.2.12` é dependência direta afetada por advisories críticos e há correção disponível. Também existem riscos de isolamento em atualizações de status, cache público do proxy de mídia e processamento não durável de webhooks.

Os arquivos `.env` e `.env.local` auditados não possuem `META_APP_ID`, `META_EMBEDDED_SIGNUP_CONFIG_ID` nem `META_WEBHOOK_VERIFY_TOKEN` preenchidos; o `META_APP_SECRET` encontrado nesses arquivos é placeholder. Isso prova que **este ambiente local** não está pronto para Embedded Signup. Não prova o estado do ambiente de produção.

---

# B. Matriz de conformidade

## B.1 Meta Business, Tech Provider e autorização

| Requisito | Classificação | Evidência | Impacto / severidade |
| --- | --- | --- | --- |
| Integração com portfólio empresarial | **NÃO VERIFICÁVEL LOCALMENTE** | O código recebe IDs da Meta, mas não armazena ou valida `business_id`; o v5 pode retorná-lo no callback. | Elegibilidade do portfólio precisa ser confirmada na Meta. P0 externo. |
| Condição de Tech Provider | **NÃO VERIFICÁVEL LOCALMENTE** | Não há consulta à classificação do provedor no repositório. Documentação exige parceiro elegível. | Pode bloquear Embedded Signup antes do backend. P0 externo. |
| App ID e App Secret corretos | **PARCIALMENTE IMPLEMENTADO** | `src/app/api/whatsapp/coexistence/route.ts:20-52` valida forma e placeholders; `route.ts:196-198` usa ambos no servidor. | No ambiente local faltam App ID e Configuration ID. Produção não verificada. P0 ambiental. |
| Modo Live do aplicativo | **NÃO VERIFICÁVEL LOCALMENTE** | Nenhum endpoint consulta o estado do app. | App em modo de desenvolvimento limita usuários externos. P0 externo. |
| Permissões `whatsapp_business_management` e `whatsapp_business_messaging` | **NÃO VERIFICÁVEL LOCALMENTE** | O código executa operações que dependem delas, mas não enumera nem consulta permissões concedidas. | Permissão informada não equivale a permissão efetiva. P0 externo. |
| Autenticação/autorização do cliente no onboarding | **PARCIALMENTE IMPLEMENTADO** | `requireRole('admin')` em `coexistence/route.ts:143,161`; state ligado a usuário/conta em `route.ts:146-154,166-171`. | Controle local correto; autorização Meta externa não verificada. |
| Onboarding de clientes externos | **PARCIALMENTE IMPLEMENTADO** | Embedded Signup e troca de token existem, mas não há sincronização obrigatória dentro de 24 h nem lifecycle completo. | Não deve ser lançado como coexistência completa. P1. |
| Aprovações e elegibilidade externas | **NÃO VERIFICÁVEL LOCALMENTE** | Dependem do App Dashboard, App Review e suporte Meta. | P0 externo. |
| App Secret apenas no servidor | **IMPLEMENTADO E VALIDADO** | `webhook-signature.ts:21-46`; `coexistence/route.ts:196-198`; nenhuma chave encontrada no código de origem cliente. | Controle confirmado na árvore auditada. |
| Chamadas Graph API server-side | **IMPLEMENTADO E VALIDADO** | Helpers em `src/lib/whatsapp/meta-api.ts`; rota de coexistência no servidor. | Tokens não retornam ao navegador. |

## B.2 Embedded Signup

| Requisito | Classificação | Evidência | Impacto / severidade |
| --- | --- | --- | --- |
| Facebook Login for Business / SDK | **IMPLEMENTADO, NÃO TESTADO** | `whatsapp-coexistence.tsx:42-53` carrega e inicializa o SDK; `:107-121` abre `FB.login`. | Teste real depende de Meta. P1. |
| Uso do Configuration ID | **IMPLEMENTADO E VALIDADO** | Servidor valida ID numérico e entrega ao cliente (`coexistence/route.ts:40-53,147-149`); cliente o envia em `whatsapp-coexistence.tsx:115-120`. | Validade e vínculo ao app não podem ser provados localmente. |
| Versão do Embedded Signup | **IMPLEMENTADO E VALIDADO** | v5 em `whatsapp-coexistence.tsx:115-120`; parser v5 em `coexistence.ts:5-22`. | Alinhado à página oficial v5. |
| `featureType: whatsapp_business_app_onboarding` | **NÃO APLICÁVEL / CORRETO EM V5** | O código usa `extras.version = "v5"`; a Meta documenta onboarding do app ativado por padrão no v5. | Não é obrigatório continuar enviando `featureType`. |
| Parâmetros de login | **IMPLEMENTADO E VALIDADO** | `config_id`, `response_type: 'code'`, `override_default_response_type: true`, `extras.setup` e `extras.version`. | Estrutura compatível. |
| Callback, cancelamento e erro | **PARCIALMENTE IMPLEMENTADO** | `message` listener em `whatsapp-coexistence.tsx:81-91`; cancelamento do `authResponse` em `:107-112`. | Eventos `CANCEL` do `postMessage` não são distinguidos ou registrados. P2. |
| Sessão incompleta / retomada | **PARCIALMENTE IMPLEMENTADO** | Estado apenas em memória e cookie de até 10 min (`route.ts:151-154`; UI `:93-101`). | Não há onboarding persistido para reconciliação após popup/erro. P2. |
| Recebimento de WABA/messaging account ID | **IMPLEMENTADO E VALIDADO** | `coexistence.ts:9-17`. | `messaging_account_ids` plural é reduzido ao primeiro ID válido. P2 se houver mais de uma conta. |
| Recebimento de Phone Number ID | **IMPLEMENTADO E VALIDADO** | `coexistence.ts:20-22`; testes em `coexistence.test.ts:14-21`. | Opcional e depois reconciliado via Graph API. |
| Authorization code recebido | **IMPLEMENTADO E VALIDADO** | `whatsapp-coexistence.tsx:107-114`. | Código nunca é persistido. |
| Troca segura do código por token | **IMPLEMENTADO E VALIDADO** | `GET /oauth/access_token` em `coexistence/route.ts:192-202`; teste `route.test.ts:75-90`. | Corrigido no working tree. |
| Persistência segura | **IMPLEMENTADO E VALIDADO** | `encrypt(accessToken)` em `route.ts:235`; teste garante que token não aparece na resposta (`route.test.ts:55-66`). | Criptografia at-rest confirmada. |
| Associação ao cliente correto | **IMPLEMENTADO E VALIDADO** | State ligado a usuário/conta (`route.ts:146-171`), token novo consulta os ativos, e gravação usa `ctx.accountId`. | Boa defesa contra `postMessage` forjado. |
| Prevenção de número duplicado entre empresas | **IMPLEMENTADO E VALIDADO** | Índice/constraint em `013_whatsapp_config_phone_number_id_unique.sql:70-83`; checagem em `route.ts:218-221`. | Corrida ainda pode retornar erro genérico de persistência. P3. |
| Diagnóstico de falha Meta | **IMPLEMENTADO, NÃO TESTADO** | Código, subcode e `fbtrace_id` preservados em `route.ts:123-138`; teste unitário em `route.test.ts:102-117`. | `step` pode ser atribuído indevidamente a `read_business_assets` quando a troca do código falha. P3. |
| Prontidão real para Embedded Signup | **PARCIALMENTE IMPLEMENTADO** | `GET` só valida presença/forma de App ID, Configuration ID e secret (`route.ts:39-53,141-149`). | Não detecta app Live, Tech Provider, permissões, domínio ou Configuration ID inválido. P2. |

## B.3 Coexistência

| Requisito | Classificação | Evidência | Impacto / severidade |
| --- | --- | --- | --- |
| Identificar número já usado no WhatsApp Business App | **IMPLEMENTADO E VALIDADO** | `selectCoexistencePhone` exige `is_on_biz_app=true` e `platform_type=CLOUD_API` (`coexistence.ts:33-37`). | Validação correta. |
| Diferir do fluxo Cloud API convencional | **IMPLEMENTADO E VALIDADO** | `connection_mode` em `037_whatsapp_coexistence.sql:2-4`; UI separada; `/register` proibido no fluxo coexistente. | Boa separação. |
| Não chamar `/register` indevidamente | **IMPLEMENTADO E VALIDADO** | Comentário e fluxo em `coexistence/route.ts:222-239`; teste `route.test.ts:55-67`. | Evita operação incompatível indicada pela Meta. |
| Assinar o Messaging account/WABA | **IMPLEMENTADO E VALIDADO** | `POST /{waba_id}/subscribed_apps` em `coexistence/route.ts:224-230`; falha não salva conexão. | Necessário e testado com mock. |
| Confirmação pelo celular e consentimento de histórico | **NÃO VERIFICÁVEL LOCALMENTE** | Ocorre no fluxo hospedado pela Meta; a UI apenas orienta `whatsapp-coexistence.tsx:127`. | Depende do cliente e da Meta. P0 externo. |
| Guardar `is_on_biz_app`/`platform_type` | **PARCIALMENTE IMPLEMENTADO** | São consultados em tempo de onboarding/verificação, mas não persistidos. | Estado de elegibilidade pode mudar sem o CRM saber. P2. |
| Estados de conexão | **PARCIALMENTE IMPLEMENTADO** | `connection_mode`, `status`, `connected_at`, `registered_at`, `subscribed_apps_at`, `last_registration_error`. `status` só admite `connected/disconnected` (`001_initial_schema.sql:197`). | Não há `syncing`, `degraded`, `onboarding_started` ou reconexão explícita. P2. |
| Desconexão e reconexão | **PARCIALMENTE IMPLEMENTADO** | `DELETE /api/whatsapp/config` remove apenas a configuração local (`config/route.ts:449-483`). | Não trata desconexão iniciada pelo celular nem confirma remoção remota. P1. |
| Perda de elegibilidade/lifecycle | **AUSENTE** | Nenhum tratamento de `account_update` em `webhook/route.ts`. | Número pode continuar marcado como conectado após offboarding. P1. |
| Recuperação de estado inconsistente | **PARCIALMENTE IMPLEMENTADO** | Diagnóstico em `config/verify-registration/route.ts:103-155`. | Reconciliação é manual; não reage a eventos Meta. P2. |
| Limite de 20 mensagens/s | **NÃO VERIFICÁVEL LOCALMENTE** | Nenhum controle local específico. | É limitação documentada da Meta, não configuração do WACRM. P2 operacional externo. |
| Múltiplos `messaging_account_ids` | **PARCIALMENTE IMPLEMENTADO** | `coexistence.ts:11-15` escolhe o primeiro ID numérico. | Pode escolher a conta errada em configuração v5 com múltiplas contas. P2. |

## B.4 Webhooks

| Requisito | Classificação | Evidência | Impacto / severidade |
| --- | --- | --- | --- |
| URL HTTPS | **NÃO VERIFICÁVEL LOCALMENTE** | Configuração de deploy externa. | Obrigatória pela Meta. P0 externo. |
| Verificação inicial do webhook | **IMPLEMENTADO E VALIDADO** | `webhook/route.ts:93-172`; valida `hub.mode`, `hub.challenge` e token. | Funciona, mas percorre e decifra todas as configurações. P3. |
| HMAC `X-Hub-Signature-256` | **IMPLEMENTADO E VALIDADO** | `webhook/route.ts:175-187`; `webhook-signature.ts:21-46`; testes dedicados. | Fail-closed quando App Secret está ausente. |
| Corpo bruto preservado | **IMPLEMENTADO E VALIDADO** | `request.text()` antes do parse em `webhook/route.ts:175-193`. | Correto para assinatura. |
| ACK rápido e processamento pós-resposta | **PARCIALMENTE IMPLEMENTADO** | `after()` em `webhook/route.ts:196-219`. | Alivia timeout, mas não é fila durável nem garante replay após falha da função. P1. |
| Associação ao cliente correto | **PARCIALMENTE IMPLEMENTADO** | Mensagens e ecos roteiam por `phone_number_id` (`route.ts:277-338`). | Status são tratados sem resolver a conta antes da atualização. P1. |
| `messages` inbound | **PARCIALMENTE IMPLEMENTADO** | `route.ts:296-357,634-919`. | Exige `contacts` e número em `from/wa_id`; não suporta BSUID sem telefone. P1. |
| `smb_message_echoes` | **PARCIALMENTE IMPLEMENTADO** | `route.ts:277-287,611-632`; RPC em `037_whatsapp_coexistence.sql:16-52`. | Tipos suportados e deduplicação corretos; `to` obrigatório descarta BSUID; revoke/edit não tratados. P1. |
| `history` | **AUSENTE** | Sem referência a `history` ou `smb_app_data` no fluxo WhatsApp. | Histórico autorizado não é importado. P1. |
| `smb_app_state_sync` | **AUSENTE** | Sem handler, tabela de contatos sincronizados ou progresso. | Contatos do app não são sincronizados. P1. |
| `account_update` | **AUSENTE** | Sem handler; o loop ignora campos desconhecidos após `route.ts:277`. | Desconexão/reconexão/offboarding não alteram o estado local. P1. |
| Idempotência de ecos | **IMPLEMENTADO E VALIDADO** | Índice único parcial em `037...sql:10-14`; `ON CONFLICT DO NOTHING` em `:29-37`. | Retry de eco não duplica. |
| Idempotência de inbound/status | **AUSENTE / INCORRETA** | Inbound faz insert direto em `route.ts:743-757`; status regride sem ladder em `:414-417`. | Retry pode duplicar inbound e status atrasado pode regredir mensagem. P1. |
| Controle de concorrência | **PARCIALMENTE IMPLEMENTADO** | Contatos e conversas têm índices únicos (`022...sql:116-120`; `036...sql:121-126`); unread usa valor lido anteriormente (`route.ts:765-771`). | Inbound concorrente pode perder incrementos e gerar triggers duplicados. P2. |
| Ordenação fora de ordem | **PARCIALMENTE IMPLEMENTADO** | Ecos usam `greatest` e preview condicional (`037...sql:39-44`); inbound usa `new Date()` (`route.ts:765-771`). | Mensagem antiga atrasada pode sobrescrever o preview inbound. P2. |
| Tratamento de erros por evento | **PARCIALMENTE IMPLEMENTADO** | `after()` captura apenas erro global (`route.ts:210-217`); não há try/catch por `entry/change`. | Um evento malformado pode interromper eventos subsequentes após o 200. P2. |
| Observabilidade e auditoria de eventos | **AUSENTE** | Apenas `console.*`; não há tabela de webhook events, tentativas ou dead-letter. | Falhas perdidas não são recuperáveis nem auditáveis no produto. P1/P2. |
| Assinatura real dos campos na Meta | **NÃO VERIFICÁVEL LOCALMENTE** | `subscribed_apps` assina a conta, mas a lista de fields é configurada no App Dashboard. | Precisa confirmar `messages`, `smb_message_echoes`, `history`, `smb_app_state_sync` e `account_update`. P0 externo. |

## B.5 Sincronização de histórico e contatos

| Requisito | Classificação | Evidência | Impacto |
| --- | --- | --- | --- |
| Iniciar sincronização autorizada | **AUSENTE** | Nenhum `POST /{phone_number_id}/smb_app_data`. | Não inicia contatos nem histórico. P1. |
| Importar histórico | **AUSENTE** | `webhook/route.ts` não possui ramo `history`. | Perda de contexto anterior ao WACRM. P1. |
| Sincronizar contatos | **AUSENTE** | Nenhum handler de `smb_app_state_sync`. | Contatos do celular não entram no CRM. P1. |
| Preservar identificadores originais | **PARCIALMENTE IMPLEMENTADO** | `message_id` é salvo em mensagens suportadas; BSUID não possui coluna. | Identidade moderna pode ser perdida. P1. |
| Duplicação de histórico/eventos | **AUSENTE** | Sem tabela de chunks/checkpoint nem unique de inbound. | Risco de duplicação ou perda em retry. P1. |
| Progresso e recuperação | **AUSENTE** | Não há `phase`, `chunk_order`, `progress`, `request_id` ou checkpoint. | Sincronização interrompida não é retomada. P1. |
| Janela de 24 horas | **AUSENTE** | Nenhum estado de início/expiração da sincronização. | O cliente pode acreditar que a importação ocorrerá depois. P1. |
| Atualização do frontend | **IMPLEMENTADO, NÃO TESTADO** | Realtime em `src/hooks/use-realtime.ts:47-70`. | Ecos inseridos devem aparecer, mas não há teste e2e. |

## B.6 Segurança, banco e operação

| Requisito | Classificação | Evidência | Impacto / severidade |
| --- | --- | --- | --- |
| Tokens cifrados at-rest | **IMPLEMENTADO E VALIDADO** | AES-256-GCM em `encryption.ts:29-103`; testes de cifra. | Bom controle básico. |
| Token não exposto no frontend | **IMPLEMENTADO E VALIDADO** | Respostas não incluem token; teste `route.test.ts:55-66`. | Confirmado no fluxo de coexistência. |
| Credenciais hardcoded | **AUSENTE** | Busca estática não encontrou App Secret/token real no código auditado. | Nenhum segredo real encontrado. |
| RLS e isolamento de tabelas operacionais | **IMPLEMENTADO, NÃO TESTADO** | Políticas por `is_account_member` em `017_account_sharing.sql:384-598`. | Falta teste de integração com Postgres/RLS. P2. |
| Leitura de `whatsapp_config` por membros | **PARCIALMENTE IMPLEMENTADO** | RLS permite SELECT ao membro (`017...sql:419-424`), mas não há column-level privilege. | Ciphertext de token fica legível via PostgREST; plaintext não. P2 em defesa em profundidade. |
| Status update isolado por tenant | **IMPLEMENTAÇÃO INCORRETA** | `route.ts:414-417,427-437` atualiza apenas por `message_id`, sem `account_id`; comentário em `:410-413` diz que IDs podem repetir. | Possível alteração de status em outro tenant se IDs colidirem. P1. |
| Media proxy autorizado pelo tenant | **PARCIALMENTE IMPLEMENTADO** | `media/[mediaId]/route.ts:51-73` busca qualquer mídia pelo ID usando o token da conta, sem validar que o ID pertence à conta. | Depende das restrições do token Meta; risco de IDOR e exposição de mídia. P1. |
| Cache de mídia privada | **IMPLEMENTAÇÃO INCORRETA** | `media/[mediaId]/route.ts:76-81` usa `public, max-age=86400`. | Conteúdo privado pode ser armazenado por CDN/proxy. P1. |
| CSRF/OAuth state | **IMPLEMENTADO E VALIDADO** | Cookie `HttpOnly`, `SameSite=Strict`, state aleatório e comparação timing-safe (`route.ts:151-171`); teste de nonce/origem. | Controle forte no fluxo local. |
| Replay de evento Meta | **PARCIALMENTE IMPLEMENTADO** | HMAC válido + dedupe só de echo; inbound e status não têm event ledger. | Replay de evento assinado pode duplicar/regredir dados. P1. |
| Expiração/revogação de token | **PARCIALMENTE IMPLEMENTADO** | Não há `expires_at`, refresh, revogação ou auditoria de rotação em `whatsapp_config`. | Falha de token exige redigitação/reset manual. P2. |
| Logs sem dados pessoais | **PARCIALMENTE IMPLEMENTADO** | `send-message.ts:433-436` registra telefone completo ao autocorrigir contato. | Exposição de PII em logs. P2/LGPD. |
| CSP e headers | **PARCIALMENTE IMPLEMENTADO** | `next.config.ts` usa CSP somente em report-only e permite `unsafe-inline`/`unsafe-eval`. | Defesa contra XSS não é efetiva. P2. |
| Dependências de produção | **IMPLEMENTAÇÃO INCORRETA** | `npm audit --omit=dev`: 2 críticas, 13 altas, 8 moderadas, 1 baixa; `next@16.2.12` direto e corrigível. | RCE e DoS dependendo da superfície exercitada. P0. |
| Auditoria de ações administrativas | **AUSENTE** | Não há tabela de auditoria para conexão, troca de token, reset ou reconexão. | Sem trilha forense. P2. |

## B.7 Versões e testes

| Requisito | Classificação | Evidência |
| --- | --- | --- |
| Embedded Signup v5 | **IMPLEMENTADO E VALIDADO** | Código usa `version: 'v5'`; página oficial confirma release em 20/10/2026 e `messaging_account_ids`. |
| Graph API versão atual | **PARCIALMENTE IMPLEMENTADO** | `meta-api.ts:12` e `templates/sync/route.ts:25` fixam v21.0; coexistência usa v25.0 por padrão. A Meta documenta v27.0 como última. |
| Teste de assinatura HMAC | **IMPLEMENTADO E VALIDADO** | 6 testes em `webhook-signature.test.ts`. |
| Teste de parser/route de Embedded Signup | **IMPLEMENTADO E VALIDADO** | 8 testes de coexistência; 74 testes Meta relevantes passaram nesta auditoria. |
| Teste real do webhook de rota | **AUSENTE** | Não existe `src/app/api/whatsapp/webhook/route.test.ts`. |
| Teste de migração/RLS/concorrência | **AUSENTE** | Não há suíte Postgres de integração para essa superfície. |

---

# C. Problemas críticos

## C.1 P0 — Dependência Next.js vulnerável

`npm audit --omit=dev` identificou `next@16.2.12` como dependência direta crítica. Os advisories incluem RCE na otimização de imagem, RCE em `next/og`, RCE em uso de cache e falhas correlatas. A versão de correção indicada pelo registry foi `16.4.5` (a ser validada com a documentação e os testes da versão 16 antes do upgrade).

Evidência: `package.json` fixa `"next": "16.2.12"`. Impactação depende de quais rotas/recursos estão expostos, mas a vulnerabilidade está na dependência principal e exige prioridade P0.

## C.2 P0 — Bloqueio externo do onboarding

O texto exato do erro não existe no repositório. A busca por `ML Informática não pode integrar clientes no momento` retornou zero ocorrências. Isso é forte evidência de que a mensagem vem da interface remota da Meta, não de `coexistence/route.ts`.

O código só é chamado depois de:

1. `GET /api/whatsapp/coexistence` preparar o SDK e o state;
2. `FB.login` retornar um código;
3. o navegador enviar `postMessage` com `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`.

Se o erro aparece antes da seleção do número, o backend WACRM não recebeu o evento de conclusão e não pode ser identificado como causa pelo código. As verificações prioritárias são Tech Provider, portfólio, Configuration ID, modo Live, permissões avançadas, domínio e OAuth.

## C.3 P1 — Sincronização de coexistência incompleta

A documentação oficial determina que, após a conclusão do onboarding, o parceiro tem 24 horas para sincronizar contatos e histórico. O WACRM não chama `POST /{phone_number_id}/smb_app_data` e não recebe `history` nem `smb_app_state_sync`. Isso impede a coexistência completa e pode exigir offboarding e novo Embedded Signup para tentar novamente.

## C.4 P1 — Lifecycle da conexão não é observado

Não há tratamento de `account_update`. Eventos `PARTNER_REMOVED`, `ACCOUNT_OFFBOARDED` e `ACCOUNT_RECONNECTED` não alteram `whatsapp_config`. O CRM pode continuar exibindo “conectado” depois de o cliente desconectar o número no celular ou trocar de aparelho.

## C.5 P1 — Identidade por BSUID não é suportada

A documentação atual informa que `wa_id`/`to` podem ser omitidos quando o usuário adota username e que `user_id`/`to_user_id` são os identificadores estáveis. O código exige `message.to` no echo (`webhook/route.ts:283`) e depende de número em `from/wa_id` para inbound. Esses eventos são descartados silenciosamente.

## C.6 P1 — Webhook não possui garantia durável

O 200 é enviado antes de `after()` concluir. Se a função serverless for encerrada, o processo falhar ou o processamento lançar erro, a Meta não recebe 5xx e não reenvia. Não há event ledger, fila, retry, dead-letter ou checkpoint. Além disso, inbound não é idempotente.

## C.7 P1 — Atualização de status sem escopo de conta

`handleStatusUpdate` atualiza todas as linhas de `messages` pelo `message_id` e depois escolhe uma linha com `limit(1)` para emitir evento. A própria linha `410-413` registra que `message_id` não é único. Mesmo que IDs sejam globalmente únicos na maioria dos casos, o desenho não preserva o isolamento por conta e pode regredir status de uma mensagem já entregue.

## C.8 P1 — Mídia privada com cache público

`GET /api/whatsapp/media/[mediaId]` autentica o usuário, mas não confirma que o `mediaId` pertence a uma mensagem/conversa da conta. A resposta usa `Cache-Control: public, max-age=86400`. Em conjunto, isso permite que a mídia privada seja armazenada por proxies/CDN e amplia o impacto de um IDOR caso o token Meta tenha acesso a mais de uma mídia.

## C.9 P1 — Pré-requisito de verificação após o login

A UI habilita o botão quando App ID, Configuration ID e segredo têm forma válida. O token de verificação do webhook só é exigido no `POST`, depois que o cliente já concluiu o fluxo Meta (`coexistence/route.ts:185-189`). Em uma primeira conexão sem `META_WEBHOOK_VERIFY_TOKEN`, o usuário faz o Embedded Signup e só então recebe falha. O código não usa o código de autorização nesse caminho, mas a experiência e a sessão ficam incompletas.

---

# D. Problemas específicos de coexistência

| Elemento | Situação atual | O que falta |
| --- | --- | --- |
| `messages` | Inbound básico; preserva telefone, cria contato/conversa e salva o texto/mídia. | BSUID, validação runtime do payload, dedupe e transação atômica. |
| `smb_message_echoes` | Texto, imagem, vídeo, áudio, documento, sticker e localização. | `revoke`, `edit`, `to`/`wa_id` ausente, `to_user_id`, erros explícitos e teste de rota. |
| `history` | Nenhum processamento. | API de sincronização, chunks, threads, mídia, progresso, erros e idempotência. |
| `smb_app_state_sync` | Nenhum processamento. | Sincronização inicial e mudanças de contatos, merge e progresso. |
| `account_update` | Nenhum processamento. | Offboarding, reconexão, remoção de parceiro, violação e degradação. |
| Janela de 24 horas | Não acompanhada. | Estado de onboarding, expiração, alerta e recuperação. |
| Anexos de histórico | Não suportados. | Tratar `media_placeholder` e webhooks adicionais de mídia somente quando a Meta os fornece. |
| Progresso | Não existe. | `request_id`, fase, `chunk_order`, percentual e checkpoint. |
| Desconexão pelo celular | Evento ignorado. | Aplicar `PARTNER_REMOVED`, `ACCOUNT_OFFBOARDED` e `ACCOUNT_RECONNECTED`. |
| Múltiplas contas/IDs | O parser escolhe o primeiro `messaging_account_id`. | Selecionar pelo `phone_number_id` ou falhar de forma explícita quando houver ambiguidade. |
| Limitações operacionais | A Meta fixa coexistência em 20 mensagens/s e não sincroniza grupos. Mensagens de desaparecimento, visualização única, localização ao vivo e listas são desativadas/limitadas no app após o onboarding. | A UI deve explicar essas mudanças e não prometer paridade integral com o WhatsApp Business App. |

**Consequência:** o WACRM consegue manter uma conversa básica com o número coexistente enquanto os webhooks chegam, mas não oferece a experiência completa de coexistência descrita pela Meta. O sistema não deve anunciar importação de histórico, contatos, edição/revogação ou reconexão automática.

---

# E. Diagnóstico do Embedded Signup

## E.1 Fluxo implementado

1. Admin abre Settings → WhatsApp.
2. `GET /api/whatsapp/coexistence` valida credenciais em forma, cria state e grava cookie.
3. Cliente carrega `connect.facebook.net`, inicializa `FB.init` e espera `FB.login`.
4. Usuário escolhe/conecta o número no fluxo hospedado pela Meta.
5. Callback `postMessage` e `FB.login` são combinados; somente o evento `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` é aceito.
6. Browser envia código, WABA ID e Phone Number ID ao servidor.
7. Servidor valida state, origem, campos e credenciais.
8. Servidor troca o código por token usando `GET /oauth/access_token`.
9. Servidor consulta os telefones do Messaging account e exige `is_on_biz_app=true` e `platform_type=CLOUD_API`.
10. Servidor verifica conflito entre contas, chama `subscribed_apps`, cifra o token e grava a configuração.

## E.2 O que está correto

- A troca por code usa `GET`, conforme documentação oficial.
- O token não retorna ao navegador.
- O token novo é usado para consultar os ativos, evitando que um `postMessage` escolha um número de outro tenant.
- O state é vinculado a usuário, conta e cookie.
- O fluxo não chama `/register`, correto para coexistência.
- A versão v5 e o formato `messaging_account_ids` estão coerentes com a documentação de novembro de 2026.
- `is_on_biz_app` e `platform_type` são verificados no servidor.

## E.3 Diagnóstico da mensagem relatada

**Fato:** a string exata não existe no repositório. **Conclusão:** ela não é emitida por nenhuma string local do WACRM; se o texto vem diretamente do popup/SDK da Meta, o fluxo falhou antes do handler de conclusão.

| Classe | Hipóteses |
| --- | --- |
| Código local comprovado | Nenhuma causa comprovada para o erro antes da seleção do número. O endpoint de conclusão não teria sido chamado. |
| Configuração local suspeita | `META_APP_ID`, `META_EMBEDDED_SIGNUP_CONFIG_ID` e `META_WEBHOOK_VERIFY_TOKEN` ausentes nos arquivos locais; o App Secret local é placeholder. |
| Externo não verificado | App em modo Development; Tech Provider ou portfólio sem a elegibilidade esperada; Configuration ID de outro app/business; login de negócios sem produto/permissão; domínio/redirect inadequado; cache de configuração antiga. |
| Restrição Meta possível | Limitação temporária de onboarding, processo de verificação, restrição de portfólio, permissões não efetivas ou requisito de suporte. |
| Hipótese de suporte oficial | O nome “ML Informática” aparece na mensagem, sugerindo decisão da Meta sobre o portfólio/provedor, não uma exceção do backend. Isso precisa de `fbtrace_id`, horário e HAR do popup para confirmação. |

## E.4 Causas que não devem ser atribuídas automaticamente ao código

- App Review pendente.
- Advanced Access não concedido.
- Portfólio sem verificação ou com restrição.
- Configuration ID inválido, de outro app ou não habilitado para coexistência.
- App não Live.
- Domínio não permitido na configuração de Login for Business.
- Usuário do Business Manager sem permissão de admin/gerenciamento.
- Restrição imposta pela Meta ao provedor ou ao cliente.

## E.5 Informações que devem ser coletadas no próximo teste

- horário exato do clique e do erro;
- URL final do popup, sem tokens/código;
- screenshot e console do navegador;
- App ID efetivo do ambiente de produção;
- Configuration ID usado no deployment;
- `fbtrace_id`, se existir;
- se o popup chega à tela de seleção/conexão de número;
- resultado de chamadas de leitura no App Dashboard e Graph API, sem operações de conexão.

---

# F. Segurança

## F.1 Controles positivos

- App Secret exigido para validar `X-Hub-Signature-256`; falha fechada.
- Corpo cru preservado antes do parse.
- Tokens de acesso cifrados em AES-256-GCM com IV aleatório e auth tag.
- Access tokens não são retornados ao navegador no fluxo de coexistência.
- OAuth state com cookie HttpOnly, SameSite Strict e comparação de tempo constante.
- RLS por conta nas tabelas principais e `service_role` restrito ao servidor.
- IDs e origem do `postMessage` não são confiados; a associação é revalidada na Graph API.
- Efeitos de echo são gravados por RPC `SECURITY DEFINER` com checagem de conversa/conta e `FOR UPDATE`.

## F.2 Vulnerabilidades e riscos

| Severidade | Achado | Evidência | Correção mínima |
| --- | --- | --- | --- |
| P0 | Dependências Next vulneráveis | `npm audit --omit=dev`; `package.json`; advisories críticos. | Atualizar Next/sharp com validação de changelog, typecheck, build e testes. |
| P1 | Status sem escopo de conta | `webhook/route.ts:403-488`; `message_id` sem unique em `009_message_actions.sql:28-37`. | Resolver config por `metadata.phone_number_id`, aplicar status com join/scope da conta e política monotônica para mensagens. |
| P1 | Cache público de mídia privada | `media/[mediaId]/route.ts:76-81`. | Usar `private, no-store`; validar que o `mediaId` pertence a uma mensagem/conversa da conta. |
| P1 | Inbound não idempotente | `webhook/route.ts:743-757`. | Evento bruto + unique por `(conversation_id, message_id)` e processamento transacional. |
| P1 | Processamento não durável | `webhook/route.ts:210-219`. | Fila/durable queue, inbox events, retries e DLQ; 5xx apenas quando o evento não foi persistido. |
| P1 | Eventos sem telefone descartados | `webhook/route.ts:283`; documentação de BSUID. | Adicionar `user_id/to_user_id/from_user_id`, identidade composta e fallback. |
| P2 | Credenciais de config legíveis por membro via RLS | `017_account_sharing.sql:419-424`. | Revogar SELECT direto de colunas sensíveis e expor apenas view/rota com necessidade administrativa. |
| P2 | PII em logs | `send-message.ts:433-436`. | Mascarar telefone e não registrar conteúdo de mensagem. |
| P2 | CSP report-only/unsafe | `next.config.ts`. | Migrar para CSP enforcing com nonce/hash e remover `unsafe-eval`. |
| P2 | Relay WAML amplia exposição | `webhook/route.ts:222-254`; `.env.local.example:101-102`. | Allowlist de host, segmentação por conta/app e avaliação de base legal/contrato. |
| P2 | Sem auditoria administrativa | Ausência de tabela de conexão/rotação/reset. | Registrar ator, conta, ação, timestamp e resultado sem segredo. |
| P3 | Webhook GET O(n) | `webhook/route.ts:107-135`. | Token de verificação global/indexado e rate limit. |

**Limitação LGPD:** o código possui cifra e RLS, mas não há evidência de base legal, retenção, direito ao esquecimento, contrato de operador com a Meta/WAML ou mascaramento de logs. O relatório não certifica conformidade LGPD.

---

# G. Arquitetura e banco de dados

## G.1 Modelo atual

- `accounts`: empresa/tenant.
- `profiles`: usuário e papel no tenant.
- `whatsapp_config`: uma configuração por conta, com `phone_number_id`, `waba_id`, token cifrado e estados básicos.
- `contacts`: contatos por conta, com deduplicação normalizada.
- `conversations`: uma conversa por contato/conta via índice único.
- `messages`: mensagens e metadados do WhatsApp.
- Migração `037`: modo de conexão, origem de mensagem e pausa de automação.

O modelo suporta várias empresas no mesmo deployment, mas **não suporta várias contas WABA/números por empresa**. `whatsapp_config.account_id` é único (`017_account_sharing.sql:320-328`). Se o produto exigir vários números por cliente, o modelo precisa evoluir de `whatsapp_config` para uma entidade de canal/telefone.

## G.2 Problemas estruturais

1. **Não há entidade de evento webhook.** Não existe status `received/processing/failed`, tentativas, `fbtrace_id`, deduplicação ou payload bruto com política de retenção.
2. **Não há entidade de sync de coexistência.** Faltam request ID, fase, checkpoint, progresso, janela e erros.
3. **Não há máquina de estados de conexão.** `connected/disconnected` não representa onboarding, aguardando confirmação, sincronizando, degradado, reconexão ou erro.
4. **Não há auditoria administrativa.** Alterações de token/configuração não deixam trilha além de `updated_at`.
5. **`registered_at` tem significado conflitante.** Na coexistência é preenchido sem `/register` (`coexistence/route.ts:231-239`), enquanto o tipo documenta que ele indica `/register` bem-sucedido (`types/index.ts:315-324`).
6. **Há atualizações não transacionais.** Inbound cria contato/conversa, insere mensagem, atualiza unread e dispara automação em chamadas separadas; falha intermediária deixa estado parcial.
7. **Concorrência de unread e ordenação.** `unread_count` é calculado a partir de uma leitura antiga e `last_message_at` usa o horário atual, não o timestamp original.
8. **Relacionamento de token e permissões é simplificado.** Não há escopos armazenados, expiração, validação periódica, rotação, revogação ou histórico.
9. **Índices de idempotência são assimétricos.** Ecos têm índice parcial; inbound/status não têm ledger nem unique equivalente.
10. **A versão Graph API está espalhada.** v21.0 em helpers gerais, v25.0 no default de coexistência e v27.0 na documentação atual. A evolução de versão exige um ponto único de configuração.

---

# H. Plano de correção

## P0 — Bloqueadores

### H-P0.1 Validar e corrigir a elegibilidade Meta

**Arquivos:** configuração do App Dashboard, Business Manager e documentação de operação; possivelmente `.env.local.example`.

**Ação:** demonstrar, com screenshots ou consultas read-only, que o app está Live, que o Tech Provider está ativo, que o Configuration ID pertence ao app e está habilitado para coexistência, que as permissões estão efetivas e que o domínio/redirect está permitido. Não alterar o número até confirmar a origem do erro.

**Risco:** classificar como bug de código uma restrição externa leva a mudanças no fluxo sem resolver o bloqueio.

**Teste de aceitação:** um usuário de teste de outro portfólio chega à tela de seleção de número; após confirmar, o callback retorna código/WABA/phone ID; o backend responde com token cifrado e assinatura de ecos.

### H-P0.2 Remover dependências críticas exploráveis

**Arquivos:** `package.json`, `package-lock.json`.

**Ação:** atualizar `next` e dependências relacionadas para versões sem advisories aplicáveis, lendo a documentação da versão antes da migração e validando breaking changes.

**Risco:** upgrade de framework pode alterar middleware, App Router, cache e runtime.

**Teste de aceitação:** `npm audit --omit=dev` sem critical aplicáveis; `npm run typecheck`, `npm run build`, testes e smoke tests de webhook/onboarding continuam passando.

## P1 — Alta prioridade

### H-P1.1 Fila durável de webhooks e inbox de eventos

**Arquivos:** `src/app/api/whatsapp/webhook/route.ts`, nova migration, worker/route de processamento.

**Ação:** no POST, após HMAC, persistir o evento e responder 200 somente quando a persistência for confirmada. Worker idempotente processa `event_id + field + entry`; retries exponenciais, DLQ e logs.

**Risco:** mudança de arquitetura serverless; requer observabilidade e cuidado com retenção.

**Teste:** replay do mesmo evento não duplica mensagem; queda do worker mantém evento pendente; 5xx apenas antes da persistência.

### H-P1.2 Deduplicacão e transação de inbound

**Arquivos:** `webhook/route.ts`, migration de `messages`, possivelmente RPC.

**Ação:** unique por conversa/message_id, função RPC que cria contato/conversa, insere mensagem e atualiza unread/metadata atomicamente.

**Risco:** migração precisa resolver dados legados sem apagar histórico.

**Teste:** dois deliveries concorrentes do mesmo `wamid` resultam em uma mensagem, um incremento e uma execução de automação.

### H-P1.3 Processar history e smb_app_state_sync

**Arquivos:** `webhook/route.ts`, novo módulo `src/lib/whatsapp/coexistence-sync.ts`, migration de sync/checkpoint.

**Ação:** iniciar os dois `smb_app_data` logo após save; persistir `request_id`; consumir phases/chunks/threads/contact changes; tratar recusa `2593109`; concluir ou expor erro dentro de 24 h.

**Risco:** volume, mídia e deduplicação; a Meta permite apenas uma tentativa até novo offboarding.

**Teste:** mocks de múltiplos chunks fora de ordem, retry, history declined, contato add/edit/remove e 100% de progresso.

### H-P1.4 Implementar account_update

**Arquivos:** `webhook/route.ts`, `whatsapp_config` migration e UI de settings.

**Ação:** mapear `PARTNER_REMOVED`, `ACCOUNT_OFFBOARDED`, `ACCOUNT_RECONNECTED`, `ACCOUNT_VIOLATION`, `ACCOUNT_DELETED` para estados e mensagens acionáveis; nunca chamar `/register` automaticamente em coexistência.

**Risco:** payload varia entre eventos; precisa identificar WABA e conta com precisão.

**Teste:** payloads oficiais da Meta e retransmissão idempotente.

### H-P1.5 Suportar BSUID e ecos incompletos

**Arquivos:** `webhook/route.ts`, `src/types/index.ts`, migration de contatos/mensagens.

**Ação:** persistir `user_id`, `from_user_id`, `to_user_id`, `parent_user_id`; aceitar ausência de telefone; resolver contato por BSUID; processar `revoke` e `edit`.

**Risco:** altera identidade e dedupe de contatos existentes.

**Teste:** echo sem `to`, inbound sem `from` numérico, username, edição e revogação.

### H-P1.6 Corrigir isolamento de status

**Arquivos:** `webhook/route.ts`, testes de rota.

**Ação:** resolver a conta e conversa pelo `phone_number_id` antes de qualquer update; aplicar a mesma regra monotônica de status a `messages` e `broadcast_recipients`.

**Risco:** payloads antigos podem não conter metadados suficientes; definir fallback seguro.

**Teste:** mesmo `message_id` em dois tenants não altera o outro; delivered nunca regride para sent.

### H-P1.7 Proteger e cachear mídia corretamente

**Arquivos:** `src/app/api/whatsapp/media/[mediaId]/route.ts`.

**Ação:** verificar que o media ID pertence a uma mensagem da conta e retornar `Cache-Control: private, no-store`.

**Risco:** downloads legítimos de mensagens antigas sem `media_url` podem exigir lookup extra.

**Teste:** membro da conta A não acessa mídia associada à conta B; cache headers não públicos.

### H-P1.8 Validar todo pré-requisito antes de abrir o popup

**Arquivos:** `coexistence/route.ts`, `whatsapp-coexistence.tsx`.

**Ação:** incluir `META_WEBHOOK_VERIFY_TOKEN`/config existente na prontidão; validar app/config via consulta read-only quando houver token; mostrar diagnóstico antes do Embedded Signup.

**Risco:** chamadas adicionais à Meta e cache; não expor detalhes sensíveis.

**Teste:** falta de verify token bloqueia o botão; Configuration ID inválido exibe erro antes do popup.

## P2 — Média prioridade

### H-P2.1 Observabilidade e auditoria

Adicionar tabela de eventos webhook, tentativas, duração, fbtrace_id e motivos; tabela de auditoria de configuração. Testes com retenção/LGPD e redaction.

### H-P2.2 Ordem e concorrência inbound

Usar timestamp Meta no preview, incremento atômico de unread e triggers idempotentes. Teste com mensagens fora de ordem e lote concorrente.

### H-P2.3 Ciclo de vida do token

Registrar validação, data de última verificação, erro de autenticação e política de reconexão; manter tokens fora de SELECT de clientes comuns. Teste de rotação e token revogado.

### H-P2.4 Unificar Graph API

Centralizar versão em um único módulo, validar formato e planejar v21 → versão suportada antes de 21/01/2027. Tipos `coexistencia` e Cloud API não devem divergir acidentalmente.

### H-P2.5 Reduzir exposição operacional

Mascarar telefone em logs, remover conteúdo/preview de logs, allowlist do relay WAML e transformar CSP em enforcing após validação.

## P3 — Melhorias

- Reprocessar corretamente o rótulo `step` quando a troca do código falhar.
- Tratar ambiguidade de múltiplos `messaging_account_ids`.
- Adicionar rate limit e índice ao handshake do webhook.
- Criar testes de UI para cancelamento, timeout e `postMessage` fora de ordem.
- Documentar uma máquina de estados de conexão e badges na UI.

---

# I. Checklist de validação externa

## Meta for Developers

- [ ] App ID do deployment corresponde ao app WACRM informado.
- [ ] App Secret do deployment corresponde ao app.
- [ ] App Secret não é placeholder e não está exposto no cliente.
- [ ] App está em modo Live.
- [ ] `facebook login`/Facebook Login for Business está configurado.
- [ ] Configuration ID existe, é do mesmo app e está habilitado para coexistência.
- [ ] Domínio HTTPS de produção está permitido para o SDK e OAuth.
- [ ] Valid OAuth Redirect URIs inclui a URL correta.
- [ ] Permissões `whatsapp_business_management` e `whatsapp_business_messaging` estão solicitadas e efetivas.
- [ ] Advanced Access/App Review está aprovado quando exigido para clientes externos.
- [ ] O app não está restrito por violação, pendência ou verificação comercial.

## Meta Business Manager

- [ ] Portfólio `ML Informática` está sem restrição.
- [ ] O usuário que inicia o fluxo tem permissão necessária no portfólio.
- [ ] O WABA informado (`1018799750847578`, fornecido pelo usuário) continua vinculado ao portfólio esperado.
- [ ] O Business ID (`126159665134730`, fornecido pelo usuário) continua correto.
- [ ] O número elegível é do WhatsApp Business App e o aplicativo atende à versão mínima 2.24.17 documentada pela Meta.
- [ ] A conta não está presa a uma solução/parceiro anterior.
- [ ] O billing/payment method do cliente está configurado quando necessário.

## Webhooks

- [ ] Callback HTTPS responde ao desafio GET com `text/plain`.
- [ ] App Secret no WACRM é exatamente o secret do app.
- [ ] Eventos POST entregues pela Meta aparecem no log com 200 após HMAC válido.
- [ ] `messages` está assinado.
- [ ] `smb_message_echoes` está assinado.
- [ ] `history` está assinado.
- [ ] `smb_app_state_sync` está assinado.
- [ ] `account_update` está assinado.
- [ ] `GET /{WABA_ID}/subscribed_apps` mostra o app WACRM.
- [ ] `GET /{PHONE_NUMBER_ID}?fields=is_on_biz_app,platform_type` retorna `true` e `CLOUD_API`.

## Teste real de coexistência

- [ ] O popup chega à seleção do número.
- [ ] O celular exibe a confirmação de conexão.
- [ ] O cliente autoriza ou recusa compartilhamento de histórico explicitamente.
- [ ] O CRM recebe o callback e salva o token sem expô-lo.
- [ ] Um inbound webhook chega ao inbox.
- [ ] Uma resposta enviada pelo app do celular aparece no inbox uma única vez.
- [ ] A automação é pausada após a resposta manual.
- [ ] Uma mensagem enviada pelo WACRM aparece no celular.
- [ ] O sync de contatos/histórico é iniciado e progride dentro de 24 h.
- [ ] Desconectar no celular produz `account_update` e muda o estado local.

---

# J. Conclusão

1. **O WACRM está preparado para integrar clientes externos?**  
   **Não para coexistência completa.** O fluxo básico existe, mas faltam histórico, contatos, lifecycle e validação externa. Para Cloud API convencional, a base está mais próxima de pronta, ainda sujeita às verificações Meta e às correções de segurança.

2. **O Embedded Signup está corretamente implementado?**  
   **Tecnicamente, sim no núcleo do v5**: SDK, configuration ID, `GET /oauth/access_token`, state, token server-side, `messaging_account_ids`, flags e `subscribed_apps`. A configuração Meta é **não verificável localmente**, e o fluxo ainda precisa de tratamento mais completo de cancelamento, ambiguidade de contas e pré-requisitos.

3. **O aplicativo suporta coexistência?**  
   **Parcialmente.** Suporta conexão básica, mensagens e ecos do app com telefone disponível; não suporta a sincronização e lifecycle completos descritos pela Meta.

4. **O recebimento de mensagens do celular está implementado?**  
   **Parcialmente.** `smb_message_echoes` é tratado e deduplicado para texto/mídia/localização, mas BSUID, edição, revogação e alguns erros são descartados.

5. **A sincronização de histórico está preparada?**  
   **Não.** Não há chamada da SMB App Data API, receptor de `history`, checkpoint, progresso ou janela de 24 h.

6. **Os webhooks necessários estão presentes?**  
   **Parcialmente.** `messages`, status e `smb_message_echoes` existem. `history`, `smb_app_state_sync` e `account_update` não existem. A assinatura efetiva desses fields na Meta é externa e não foi confirmada.

7. **Existem vulnerabilidades graves?**  
   **Sim.** Dependências Next críticas, atualização de status sem tenant, inbound não idempotente, processamento não durável, BSUID descartado e mídia privada com cache público exigem correção prioritária.

8. **O que impede a coexistência de funcionar atualmente?**  
   Primeiro, o bloqueio externo que produz o erro antes do número. Depois, a ausência de sync/history/state/account_update e o tratamento parcial de identidade e ecos. Não é possível atribuir o erro relatado ao código sem evidência do callback ou `fbtrace_id`.

9. **Quais problemas podem ser corrigidos apenas no código?**  
   Histórico/contatos, account_update, BSUID, idempotência/queue, isolamento de status, mídia, máquina de estados, testes, versão Graph API, redaction e dependências.

10. **Quais dependem de autorização ou configuração externa da Meta?**  
    Tech Provider, portfólio, App Review/permissões, App Live, Configuration ID, Facebook Login for Business, domínios/redirects, assinatura dos webhooks e elegibilidade específica do número/cliente.

---

# K. Evidências executadas e fontes

## K.1 Comandos e resultados da auditoria original

| Verificação | Resultado |
| --- | --- |
| `npm run typecheck` | Passou. |
| `npm run build` | Passou; Next.js 16.2.12/Turbopack compilou e gerou 57 páginas em produção. |
| `npm run lint` | 0 erros; 40 warnings, incluindo dependências de hooks e imports não usados. |
| `npx vitest run` específico de coexistência, HMAC, cifra, registro, meta API, template webhook e pausa | 8 arquivos, 74 testes, todos passaram. |
| `npm test` completo | 71 arquivos passaram; 4 falharam, 693/700 testes passaram. As 7 falhas são de locale/formatação de moeda, datas e mensagens localizadas, não dos testes Meta direcionados. O host local usa Node v24.22.1; o CI do projeto usa Node 20, portanto esses resultados sensíveis a locale/timezone precisam ser reconfirmados nessa versão. |
| `npm audit --omit=dev --json` | 24 vulnerabilidades: 2 críticas, 13 altas, 8 moderadas, 1 baixa. `next@16.2.12` aparece como dependência direta crítica. |
| Busca da mensagem do erro no repositório | Zero ocorrências. |
| Verificação de segredos | Nenhum App Secret/token real hardcoded encontrado nas áreas de código inspecionadas. |
| Operações Meta reais | Nenhuma; sem token autorizado e sem autorização para conectar/desconectar/migrar números. |

## K.2 Documentação oficial consultada em 06/11/2026

- Meta — Embedded Signup v5, atualizado em 27/10/2026: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-5/
- Meta — Onboard WhatsApp Business app users (Coexistência), atualizado em 29/10/2026: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/
- Meta — Onboarding de clientes como Tech Provider: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider/
- Meta — Webhook `account_update`: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update/
- Meta — Webhook `history`: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/history/
- Meta — Webhook `smb_app_state_sync`: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/smb_app_state_sync/
- Meta — Webhook `smb_message_echoes`: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/smb_message_echoes/
- Meta — Access tokens: https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens/
- Meta — Graph API changelog/versões: https://developers.facebook.com/docs/graph-api/changelog/

## K.3 Fatos documentais que sustentam o laudo

- O v5 foi lançado em 20/10/2026; `extras.version: "v5"` é o contrato atual, o onboarding do Business App fica ativo por padrão e o session info retorna `messaging_account_ids`, não `waba_id`.
- A página de coexistência informa que se deve **pular** `/register` porque o número já está registrado.
- A Meta exige ou orienta a assinatura de `account_update`, `history`, `smb_app_state_sync` e `smb_message_echoes`.
- Há 24 horas após o onboarding para iniciar a sincronização; depois pode ser necessário offboarding e novo Embedded Signup.
- A página de histórico descreve até os últimos 6 meses de conversas, chunks por fase/progresso e mídia adicional.
- `smb_message_echoes` pode omitir `to`/`wa_id` quando o usuário usa username; `to_user_id` é o identificador a usar.
- `account_update` inclui `PARTNER_REMOVED`, `ACCOUNT_OFFBOARDED`, `ACCOUNT_RECONNECTED` e outros estados de ciclo de vida.
- Graph API v27.0 é a versão mais recente documentada; v21.0 permanece listada até 21/01/2027.

---

# L. Correções aplicadas após a auditoria

## L.1 Segurança e dependências

| Correção | Implementação |
| --- | --- |
| Dependências críticas/altas | `next` e `eslint-config-next` atualizados para 16.4.5; dependências transitivas atualizadas com `npm audit fix`. O servidor MCP foi atualizado para MCP SDK 1.32.2 e Zod 4.6.7. |
| Verificação final | App: 0 críticas, 0 altas, 4 moderadas, 2 baixas em dependências de produção. MCP: 0 vulnerabilidades. |
| Proxy Next.js 16 | `middleware.ts` migrado para `proxy.ts`, preservando refresh de cookies e redirects otimistas. |
| Mídia | Rota agora confirma que `media_id` pertence a uma mensagem da conta e responde com `Cache-Control: private, no-store` e `nosniff`. |
| Status multi-tenant | Mensagens e destinatários de broadcast são resolvidos pelo `phone_number_id` e pela conta antes da atualização. Status de `messages` segue regra monotônica. |
| OAuth/API administrativa | `POST/DELETE /api/whatsapp/config` exige papel `admin`; handshake GET tem rate limit e comparação de token em tempo constante; payloads de webhook têm limite de 2 MB. |
| PII/relay | Telefone autocorrigido é mascarado em log; relay WAML aceita allowlist opcional de hosts HTTPS. |
| CSP | CSP pode ser ativada com `CSP_ENFORCE=true`; `unsafe-eval` fica limitado ao ambiente de desenvolvimento. |
| Auditoria administrativa | Nova tabela `admin_audit_log`, leitura apenas para admins e escrita via service role, registra conexão, sync e configuração sem tokens. |

## L.2 Webhooks e persistência

- O POST verifica HMAC e persiste cada `entry/change` em `whatsapp_webhook_events` **antes** de responder 200.
- Eventos são divididos por change, portanto a falha de um `history`, `account_update` ou outro evento não bloqueia o restante da entrega.
- `claim_whatsapp_webhook_event` faz claim atômico; eventos travados em `processing` por mais de 10 minutos podem ser reclamados.
- Tentativas usam backoff exponencial, com limite de oito tentativas e erro persistido.
- `POST /api/whatsapp/webhook/retry`, protegido por `WHATSAPP_WEBHOOK_RETRY_SECRET`, drena eventos pendentes/falhos e remove payloads processados após 30 dias.
- Mensagens inbound/históricas usam o RPC transacional `record_whatsapp_message`, com lock da conversa, unique index e atualização atômica de preview/unread.

## L.3 Coexistência

- `history` importa chunks e threads, preserva IDs Meta, deduplica por conversa/mensagem, atualiza progresso e não incrementa unread nem dispara automações.
- `smb_app_state_sync` adiciona/edita/marca contatos como removidos, sem apagar histórico de clientes.
- `smb_message_echoes` suporta telefone ou BSUID, além de `revoke` e `edit`.
- `account_update` trata `PARTNER_REMOVED`, `ACCOUNT_OFFBOARDED`, `ACCOUNT_RECONNECTED`, `ACCOUNT_DELETED` e atualiza o estado da conexão.
- Após o Embedded Signup, o app inicia os dois streams `smb_app_data`; também há botão e endpoint explícito para retomar quando a sincronização não começou.
- O parser v5 preserva todos os `messaging_account_ids` e o servidor escolhe a conta que realmente contém o Phone Number ID.
- Graph API foi centralizada em `META_GRAPH_API_VERSION`, com default `v27.0`.

## L.4 Migração necessária

A correção de banco está no arquivo:

- `supabase/migrations/040_whatsapp_reliability.sql`

Ela ainda **não foi aplicada** a um banco Supabase pelo agente. Antes de iniciar o app corrigido, o operador deve aplicá-la no ambiente alvo e configurar:

- `META_GRAPH_API_VERSION=v27.0`
- `WHATSAPP_WEBHOOK_RETRY_SECRET=<segredo aleatório longo>`
- `WAML_WHATSAPP_WEBHOOK_ALLOWED_HOSTS=<host permitido>` quando o relay WAML estiver ativo
- `CSP_ENFORCE=true` somente após smoke test de login, inbox, mídia e Embedded Signup
- assinatura dos cinco webhook fields no App Dashboard

A migração pode falhar de forma segura se já existirem mensagens duplicadas em `(conversation_id, message_id)`; nesse caso o operador deve resolver os conflitos antes de repetir, sem exclusão automática de histórico.

A migração `040_whatsapp_reliability.sql` foi aplicada pelo operador após a auditoria. A correção concorrente descrita em L.8 requer também aplicar `supabase/migrations/041_whatsapp_coexistence_sync_claims.sql` antes do deploy.

## L.5 Validação final executada

| Verificação | Resultado final |
| --- | --- |
| `npm run typecheck` | Passou. |
| `npm run typecheck --prefix mcp-server` | Passou. |
| `npm test` | **83 arquivos, 724 testes, todos passaram.** |
| `npm run build` | Passou com Next.js 16.4.5; 59 páginas processadas e ambas as rotas novas de sync/retry presentes. |
| `npx eslint . --quiet` | 0 erros. |
| `npm run build --prefix mcp-server` | Passou. |
| `npm audit --omit=dev` | 0 críticas e 0 altas no app; 0 vulnerabilidades no MCP. |
| Operações Meta/banco reais | Nenhuma conexão, desconexão, migração, deploy ou aplicação de migration foi executada. |

## L.6 Pendências externas e riscos residuais

1. O erro “ML Informática não pode integrar clientes no momento” continua dependendo da elegibilidade/configuração real na Meta. O código novo melhora o diagnóstico, mas não pode aprovar Tech Provider, permissões ou Configuration ID.
2. A migration 040 foi aplicada pelo operador; a migration adicional 041 está pendente no Supabase alvo.
3. Os cinco webhook fields precisam ser assinados no App Dashboard; a assinatura da conta sozinha não garante os eventos.
4. O CSP enforcing deve ser habilitado somente depois do smoke test do SDK da Meta.
5. A importação histórica depende do consentimento do cliente no celular e está sujeita aos limites da Meta.
6. Uma falha depois da inserção da mensagem e antes de uma automação ainda pode exigir reconciliação operacional; a mensagem em si não é duplicada.
7. A condição de corrida em `startCoexistenceSync` foi corrigida na seção L.8 com claims atômicos por stream e teste concorrente.

## L.7 Revalidação em 09/11/2026

| Verificação | Resultado |
| --- | --- |
| `npm test` | Passou: 83 arquivos e 724 testes. |
| Testes direcionados de coexistência, webhooks, mídia e proxy | Passou: 10 arquivos e 47 testes. |
| `npm run typecheck` | Passou. |
| `npm run lint -- --quiet` | Passou sem erros. A execução sem `--quiet` também terminou sem erros, com warnings existentes. |
| `npm run build` | Passou com Next.js 16.4.5; gerou as rotas de sincronização e retry. O build emitiu aviso de depreciação do Edge Runtime. |
| `npm audit --omit=dev` | 0 críticas/altas; 4 moderadas e 2 baixas em dependências transitivas de `shadcn`/`ts-morph`. A correção automática sugerida exige atualização breaking do `shadcn`. |
| Supabase/Meta reais | Não executados: a migration 040 não foi aplicada e não foram realizadas operações de conexão, sincronização ou webhook na Meta. |

## L.8 Correção dos achados adicionais em 09/11/2026

- A sincronização de contatos e histórico usa claims independentes com atualização condicional atômica; chamadas concorrentes não iniciam o mesmo stream duas vezes.
- A migration `041_whatsapp_coexistence_sync_claims.sql` adiciona os campos de claim. Ela precisa ser aplicada após a migration 040 e antes do deploy desta correção.
- Erros HTTP 4xx explícitos da Meta liberam o claim para uma nova tentativa. Falhas de rede, respostas 5xx ou respostas sem `request_id` mantêm o claim, pois a Meta pode ter aceitado a operação. O claim pendente é sinalizado na UI; recuperação requer conferir o estado na Meta antes de limpar manualmente.
- A UI distingue sincronização já solicitada, em andamento e falha parcial.
- A dependência CLI `shadcn` foi removida do app por não ser usada pelo código e trazer `deepmerge` vulnerável sem versão corrigida publicada. `minimatch` foi atualizado por override para a versão corrigida usada pelo `typescript-eslint`.
- As variantes Tailwind `data-open`, `data-closed`, `data-checked`, `data-disabled`, `data-active`, `data-horizontal` e `data-vertical` usadas pela UI agora estão definidas localmente; os componentes de accordion/overlay preservam o comportamento sem depender do CLI.
- `npm audit` passou sem vulnerabilidades após a mudança.
- A primeira tentativa de deploy revelou que o `tsconfig.json` raiz incluía fontes do MCP sem instalar as dependências do subprojeto. O MCP foi excluído apenas do typecheck/build raiz e validado separadamente com seus próprios comandos.
- Migration 041 confirmada como aplicada pelo operador antes do deploy.

## L.9 Validação após as correções adicionais

| Verificação | Resultado |
| --- | --- |
| `npm test` | Passou: 83 arquivos e 728 testes. |
| `npm run typecheck` | Passou. |
| `npm run lint -- --quiet` | Passou sem erros. |
| `npm run build` | Passou; rotas de coexistência sync/retry incluídas. Aviso residual do Edge Runtime. |
| `npm audit` | 0 vulnerabilidades (492 pacotes auditados). |
| MCP | `npm run typecheck --prefix mcp-server` e `npm run build --prefix mcp-server` passaram. |
| Deploy de produção | Pronto em 09/11/2026: `https://wacrm-iota-lac.vercel.app`; `vercel inspect` reportou Ready e smoke test com redirect de locale seguido de HTTP 200. |

## L.10 Correção da indisponibilidade do onboarding pelo celular

- Causa: a prontidão e a conclusão do Embedded Signup aceitavam somente um token da própria conta ou `META_WEBHOOK_VERIFY_TOKEN`, embora o webhook suporte tokens já persistidos nas configurações de outras contas.
- A rota agora consulta, no servidor com service role, um token já salvo quando a conta ainda não tem um. O valor cifrado não é devolvido à interface. `META_WEBHOOK_VERIFY_TOKEN` continua sendo necessário quando a instalação ainda não possui nenhuma configuração WhatsApp com token.
- Testes cobrem prontidão e conexão de uma conta nova com variável ausente e token previamente salvo.
- `npm test`: 83 arquivos, 730 testes passaram; typecheck, lint e build passaram; `npm audit`: zero vulnerabilidades.
- Deploy de produção atualizado em 09/11/2026: `https://wacrm-iota-lac.vercel.app`, estado Ready; smoke test HTTP 200.

## L.11 Configuração independente do token do webhook

- Causa: a tela exigia o ID do número e o access token para salvar `verify_token`, impedindo a configuração inicial do webhook em uma instalação sem WhatsApp conectado.
- A configuração agora é separada e restrita ao proprietário da conta. O token fica cifrado em `whatsapp_webhook_settings`, não é devolvido pela API e pode ser salvo sem credenciais de número; a verificação de desafio aceita esse token antes de qualquer número ser conectado.
- A migration `042_whatsapp_webhook_settings.sql` precisa ser aplicada antes de publicar esta alteração.
- Validação desta correção: `npm test` passou com 85 arquivos e 735 testes; `npm run typecheck`, `npm run lint` e `npm run build` passaram (lint/ build mantêm apenas avisos preexistentes do projeto).
- Nenhum deploy desta correção foi feito, pois a migration 042 ainda não foi confirmada como aplicada.

---

## Encerramento

As seções A–K documentam a linha de base e as evidências da auditoria. A seção L documenta as correções autorizadas e aplicadas. O próximo passo é aplicar a migração no ambiente controlado, configurar os segredos/fields externos e executar a validação de produção com um número de teste.
