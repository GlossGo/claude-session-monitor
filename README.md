# Claude Session Monitor

Tüm açık Claude Code oturumlarını (VS Code sekmelerini) tek panelde **canlı** izle:
hangisi çalışıyor, hangisi senden cevap bekliyor, hangisi oturum/rate limitine takıldı.

10-15 sekmeyle çalışırken hangisinin ne durumda olduğunu tek bakışta görmek için.

## Ne gösterir

Activity Bar'da "Claude Oturumları" paneli, durumlara göre gruplu:

| Grup | Anlamı |
|------|--------|
| 🔴 **Limit** | Oturum limiti (reset saatiyle) veya rate limit'e takıldı |
| 🟡 **Seni bekliyor** | İzin/girdi bekliyor (Notification) — senin müdahaleni istiyor |
| 🔵 **Turn bitti** | Cevabı bitirdi, senin sıran |
| 🟢 **Çalışıyor** | Aktif işliyor (90sn aktivite yoksa "yanıt yok?" uyarısı) |
| ⚪ **Kapandı** | Oturum sonlandı |

Ayrıca:
- **Status bar** özeti: `$(pulse) 🟢n 🟡n 🔵n 🔴n` — limit varken kırmızı, bekleyen varken sarı arka plan.
- **Toast bildirim**: bir oturum "seni bekliyor" ya da "limit" durumuna geçince (açılışta sessiz).

## Durum nasıl tespit edilir

İki kaynak birleştirilir, `vscode` API'sine bağımlı olmayan saf bir veri katmanında (`src/core.ts`):

1. **Hook durum dosyaları** — `~/.claude/session-monitor/<id>.json`. `hook.py` (Claude Code
   hook'u) SessionStart / UserPromptSubmit / Stop / Notification / SessionEnd olaylarında
   yazar. "Seni bekliyor" sinyali yalnızca buradan gelir (transcript'te persist edilmez).
2. **Transcript tail** — `~/.claude/projects/.../<id>.jsonl` son ~512KB'ı. Buradan:
   - **Başlık** (`ai-title`, fallback `last-prompt`),
   - en yeni **conversational** satır (working/turn-bitti),
   - **limit** tespiti (`isApiErrorMessage` + 429: "hit your session limit" vs
     "temporarily limiting / Rate limited"),
   - **entrypoint** (sadece `claude-vscode`/`cli` gösterilir; `sdk-cli`/`sdk-py` olan
     claude-mem observer + subagent oturumları elenir).

Hook olayı ile transcript'in en yeni timestamp'i karşılaştırılır; hangisi yeniyse o kazanır.
Limit, en yeni conversational olay api-error ise öne çıkar.

## Kurulum

Hook katmanı (bir kez, `~/.claude/settings.json`'a additive olarak):

```jsonc
"hooks": {
  "SessionStart":     [{ "matcher": "startup|resume|clear|compact",
                         "hooks": [{ "type": "command", "command": "python3 ~/.claude/session-monitor/hook.py SessionStart" }] }],
  "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "python3 ~/.claude/session-monitor/hook.py UserPromptSubmit" }] }],
  "Stop":             [{ "hooks": [{ "type": "command", "command": "python3 ~/.claude/session-monitor/hook.py Stop" }] }],
  "Notification":     [{ "hooks": [{ "type": "command", "command": "python3 ~/.claude/session-monitor/hook.py Notification" }] }],
  "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "python3 ~/.claude/session-monitor/hook.py SessionEnd" }] }]
}
```

Eklenti:

```bash
npm install
npm run build
npm run package        # -> claude-session-monitor-0.1.0.vsix
code --install-extension claude-session-monitor-0.1.0.vsix
```

VS Code penceresini yenile (Developer: Reload Window).

## Ayarlar

| Ayar | Varsayılan | Açıklama |
|------|-----------|----------|
| `claudeSessionMonitor.notifyOnWaiting` | `true` | "seni bekliyor" geçişinde bildirim |
| `claudeSessionMonitor.notifyOnLimited` | `true` | limit geçişinde bildirim |
| `claudeSessionMonitor.notifyOnDone` | `false` | "turn bitti" geçişinde bildirim |
| `claudeSessionMonitor.pollIntervalMs` | `1500` | yenileme aralığı |
| `claudeSessionMonitor.recentScanMaxAgeHours` | `6` | son N saatte aktif oturumları göster |
| `claudeSessionMonitor.hideEndedAfterMinutes` | `30` | kapanan oturumları gizle |
| `claudeSessionMonitor.workspaceOnly` | `false` | sadece bu workspace oturumları |

## Geliştirme

```bash
npm run watch     # esbuild --watch
npm run verify    # core veri katmanını gerçek transcript'lere karşı çalıştır
```

## Lisans

MIT
