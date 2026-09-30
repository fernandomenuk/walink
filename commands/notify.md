---
description: Show or change walink's WhatsApp pings (on, off, or minutes before a finished task pings)
argument-hint: "[on|off|<minutes>]"
---
Run this command yourself and tell the user its output in one line:

```
node "${CLAUDE_PLUGIN_ROOT}/server.js" notify $ARGUMENTS
```

It only changes a small settings file (it never touches WhatsApp) and applies right away, with no restart.
