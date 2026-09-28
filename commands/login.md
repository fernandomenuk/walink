---
description: Link your WhatsApp to walink (scan a QR code)
---
Tell the user to open a separate terminal window and run exactly this command (the QR code needs a real terminal):

```
node "${CLAUDE_PLUGIN_ROOT}/server.js" login
```

Then, on their phone: WhatsApp > Settings > Linked devices > Link a device, and scan the QR code. The command finishes by itself after contacts sync (about 20 seconds after linking). This session picks up the link within about 10 seconds; they can check with whatsapp_status.

Do not run the command yourself.
