# Arquitetura do GrowPilot

## Visão geral

```
 Sensores e atuadores (Tuya)         Celular / PC (navegador)
        ▲        │                          ▲        │
        │        ▼                          │        ▼
   ┌──────────────────────────────────────────────────────┐
   │  Servidor Node.js + Express (PM2, PC dedicado)       │
   │                                                      │
   │  controlLoop ──► vpd / steering ──► decisão          │
   │       │                                  │           │
   │       ▼                                  ▼           │
   │  history (JSON)                    tuyaClient ──► Tuya Cloud
   │       │                                              │
   │       ▼                                              │
   │  alerts ──► Telegram        backup ──► pastas extras │
   │  heartbeat ──► monitor externo                       │
   └──────────────────────────────────────────────────────┘
```

## Ciclo de controle

A cada intervalo configurável (60 s por padrão):

1. Lê temperatura e umidade dos sensores pela API da Tuya.
2. Calcula o VPD (do ar e de folha).
3. Compara com a faixa-alvo do período atual (dia/noite) e do modo de *steering*.
4. Decide ligar ou desligar umidificador, desumidificador e ar-condicionado, respeitando a **histerese** e limites de segurança (tempo máximo contínuo, pausa do compressor).
5. Registra o histórico e verifica se os equipamentos estão **tendo efeito**; se não estiverem, envia alerta.

## Camadas de proteção

| Risco | Proteção |
|---|---|
| Sensor offline | Alerta imediato |
| Equipamento ligado sem efeito | Verificação de progresso após tempo contínuo ligado |
| Backup parado | Alerta de falha e alerta de backup "velho" (mais de 30 h) |
| Queda do sistema | Heartbeat para um monitor externo, com aviso no celular |
| Acesso indevido | Sessões `HttpOnly`, senhas com scrypt e perfis validados no servidor |
| Excesso de alertas | Espaçamento crescente entre repetições e limite por hora e por dia |

## Dados

Todo o estado fica em arquivos JSON na pasta `data/` (configurações, histórico, diário, tarefas, usuários). Um backup compactado é gerado todo dia, mantém os últimos 14 e é copiado para pastas extras fora do PC (OneDrive e pendrive). A restauração cria antes um backup de segurança do estado atual.

## Front-end

Páginas HTML independentes, com JavaScript puro, que consomem a API REST. O mesmo código atende desktop e celular: no celular o layout muda para um modo compacto, com menu lateral e painéis recolhíveis.

## O que ficou de fora deste repositório

O ciclo de controle completo, a lógica de *steering*, a irrigação, a API e as telas ficam em um repositório privado. Os módulos de infraestrutura (cliente Tuya, alertas, autenticação, backup, heartbeat e verificação de efeito) estão em `code-samples/`. Posso apresentar o resto ao vivo ou em uma conversa técnica.
