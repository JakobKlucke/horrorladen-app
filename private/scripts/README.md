# Private script source files

Place plaintext Regiebuch JSON files here for local import/encryption only.

These files are intentionally not copied by Vite and are ignored by Git. Encrypt
them for Supabase with:

```bash
SCRIPT_MASTER_KEY=... node tools/encrypt_scripts.mjs
```
