---
description: Show or switch walink's auto-reply for every chat (on or off)
argument-hint: "[on|off]"
---
Run this command yourself and tell the user its output in one line:

```
node "${CLAUDE_PLUGIN_ROOT}/server.js" autoreply $ARGUMENTS
```

It only changes a small settings file (it never touches WhatsApp) and applies right away, with no restart. To enable or disable one person, ask Claude (whatsapp_autoreply_enable / whatsapp_autoreply_disable).
