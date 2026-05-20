# claude-channels-custom-tg

> *Read this in [English](./README.en.md)*

Запускает **несколько параллельных Claude Code сессий через один Telegram-бот**: каждая сессия живёт в своём forum-топике. Первое сообщение в новом топике автоматически поднимает claude; удалённые топики обнаруживаются и зачищаются; бот работает как systemd user service.

Это сильно переделанный форк официального плагина [`telegram@claude-plugins-official`](https://github.com/anthropics/claude-code/tree/main/plugins) + отдельный диспетчер-демон, который занимается всей межсессионной координацией.

## Быстрый старт

```bash
git clone https://github.com/elstatic/claude-channels-custom-tg ~/claude-channels-custom-tg
cd ~/claude-channels-custom-tg
./install.sh
# вписать токен из BotFather в ~/.claude/channels/telegram/.env
systemctl --user enable --now telegram-launcher.service
```

Дальше пишешь боту в Telegram для пэйринга, в любой claude-сессии запускаешь `/telegram:access pair <код>` — и готово. Полную последовательность шагов `install.sh` печатает в конце.

## Требования

Эти штуки надо поставить заранее — установщик только проверяет их наличие (и предлагает поставить, если запущен интерактивно):

| Инструмент | Зачем нужен                                                          |
| ---------- | -------------------------------------------------------------------- |
| bun        | на нём работают диспетчер и MCP                                      |
| tmux       | каждая claude-сессия живёт в собственной detached-tmux-панели        |
| claude     | Claude Code CLI                                                      |
| jq         | мерж конфигурации в существующий `~/projects/.claude/settings.json`  |
| systemd user manager | диспетчер запускается как `telegram-launcher.service`      |

Плюс **в BotFather**: `/mybots → твой бот → Bot Settings → Allow Topics in Private Chats`. Без этой настройки получишь одну сессию в корне DM (как в апстрим-плагине); с настройкой — каждый топик это параллельная сессия.

Если user-сервисы у тебя не переживают логаут: `sudo loginctl enable-linger $USER`.

## Архитектура

```
        ┌────────────────────────────────────┐
        │  telegram-launcher (systemd unit)  │  ← единственный владелец bot.pid + getUpdates
        │  - access-gate, pairing, /effort   │
        │  - SessionRegistry по thread_id    │
        │  - spawnSession на первом сообщ.   │
        │  - Unix-сокет: dispatcher.sock     │
        └───────────────┬────────────────────┘
                        │  inbound JSON по сокету
        ┌───────────────┼───────────────┬───────────────┐
        ▼               ▼               ▼               ▼
   tmux+claude     tmux+claude     tmux+claude    ...
   по топикам      по топикам      по топикам
   (MCP-чайлд)     (MCP-чайлд)     (MCP-чайлд)
```

- **`telegram-launcher/launcher.ts`** — демон-диспетчер. Один процесс, держит long-poll бот-токена, маршрутизирует входящие в нужный per-topic MCP через `dispatcher.sock`.
- **`telegram-ss/server.ts`** — in-session MCP. По экземпляру на claude-сессию (на топик). На старте коннектится к сокету диспетчера. Outbound (`reply`, `react`, …) идёт через `bot.api` напрямую, с `message_thread_id` авто-инжектом под капотом.
- **`telegram-launcher/claude-channels-tmux`** — bash-обёртка, которая стартует claude в именованной tmux-сессии с нужным окружением (`CLAUDE_THREAD_ID`, `CLAUDE_CHAT_ID`, `CLAUDE_DISPATCHER_SOCK`).

Состояние живёт в `~/.claude/channels/telegram/`:
- `.env` — токен бота (`TELEGRAM_BOT_TOKEN=...`, права 0600)
- `access.json` — пэйринг / allowlist, управляется скиллом `/telegram:access`
- `bot.pid` — single-instance маркер диспетчера
- `dispatcher.sock` — Unix-сокет, к которому коннектятся MCP'шки
- `sessions.json` — персистентный registry `(thread_id → tmux-сессия)`

## Что добавилось относительно апстрима

Поведения, которых нет в обычном `telegram@claude-plugins-official`:

- **Multi-session по топикам**: каждый forum-топик в твоём DM с ботом — отдельная независимая Claude Code сессия со своей историей и своей tmux-панелью.
- **Автозапуск на первом сообщении**: никаких Launch-кнопок — пишешь в свежий топик, claude поднимается сам, сообщение буферится и доставляется как только MCP подключится к сокету.
- **Постоянный индикатор «печатает»** на время старта (~5с) чтобы было видно что что-то происходит.
- **Авто-именование топиков**: диспетчер сначала переименовывает в обрезанную первую строку, потом claude через MCP-tool `rename_topic` переписывает в осмысленный 2-5-словный заголовок в стиле ChatGPT.
- **Детектирование удалённых топиков**: диспетчер периодически делает stealth-probe (`sendMessage` + мгновенный `deleteMessage`); если возвращается `message thread not found` — kill'ит соответствующую tmux-сессию.
- **MCP сам стартует typing+streaming на каждый inbound**, не дожидаясь явного `start_typing` от claude.
- **`/effort, /model, /mode, /clear, /interrupt, /resume`** маршрутизируются в нужный топик через диспетчер → MCP RPC.
- **Диалоги-подтверждения как кнопки**: когда в TUI claude всплывает `❯ 1. Yes 2. No` — мирорится в Telegram как inline-buttons.
- **Live-стриминг** in-flight tool-calls через `sendMessageDraft` — одно живо-обновляющееся сообщение вместо цепочки промежуточных.
- **Уведомление о падении**: если сессия отвалилась (краш или ручной `tmux kill-session`), диспетчер постит в топик «Claude остановился» + меню перезапуска.

## Структура репозитория

```
.
├── install.sh                       # one-shot установщик (идемпотентный)
├── README.md                        # вот это
├── README.en.md                     # English version
├── CHANGELOG.md                     # история изменений
├── telegram-launcher/
│   ├── launcher.ts                  # диспетчер
│   ├── ipc.ts                       # протокол Unix-сокета
│   ├── sessions.ts                  # SessionRegistry + persist
│   ├── claude-channels-tmux         # bash-обёртка для tmux+claude
│   ├── telegram-launcher.service.in # шаблон systemd-юнита
│   └── package.json                 # зависимость grammy
└── telegram-ss/
    ├── server.ts                    # сам MCP
    ├── package.json
    ├── README.md                    # апстрим-доки, оставлены для справки
    ├── ACCESS.md                    # схема access.json и flow /telegram:access
    └── skills/                      # скиллы /telegram:access, /telegram:configure
```

## Лицензия

Apache-2.0, как у апстрим-плагина.
