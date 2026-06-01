---
name: platform-whatsapp
description: Connect Hermes to WhatsApp via QR pairing (Baileys, no Meta dev account). Handles the phone-number allowlist. Use when wiring WhatsApp.
---

# /platform-whatsapp — wire WhatsApp (QR pairing)

WhatsApp uses QR pairing (WhatsApp Web emulation) — this needs the **user's phone** (a human step),
so it's the "add it next" platform, not the headless first choice.

## Procedure
```bash
HERMES="$HOME/.local/bin/hermes"
"$HERMES" config set WHATSAPP_ENABLED true
# Allowlist = BARE phone numbers, country code, NO '+' and NO spaces. Comma-separate multiples.
"$HERMES" config set WHATSAPP_ALLOWED_USERS "15551234567"
chmod 600 ~/.hermes/.env
"$HERMES" whatsapp            # prints a QR code
```
Then have the user scan it: WhatsApp → **Settings → Linked Devices → Link a Device**.

## Pitfalls
- **`WHATSAPP_ALLOWED_USERS` is effectively mandatory** — without it access is wide open.
- Allowlist is **bare phone numbers** (`15551234567`), no `+`. Do **NOT** use the internal `@lid`
  format — LID resolution is a known open bug (#14486/#15108); the documented format is the phone number.
- The session is stored under `~/.hermes/platforms/whatsapp/session` and survives restarts.

## Verify
User messages the linked number from the allowed phone and gets a reply.
