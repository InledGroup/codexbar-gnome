# codexbar-cookie-importer

**EN**: A Python utility to extract session cookies for the CodexBar GNOME Shell Extension.
This package retrieves encrypted cookies from Chromium-based browsers (Chrome, Brave, Chromium) using the Linux keyring (secretstorage) and decrypts them for session authentication with Codex.

**ES**: Una utilidad en Python para extraer cookies de sesión para la extensión de GNOME Shell CodexBar.
Este paquete recupera cookies encriptadas de navegadores basados en Chromium (Chrome, Brave, Chromium) usando el llavero de Linux (secretstorage) y las desencripta para la autenticación de sesión con Codex.

## Installation / Instalación

```bash
pip install codexbar-cookie-importer
```

Or using pipx:
```bash
pipx install codexbar-cookie-importer
```

## Usage / Uso

```bash
codexbar-cookie-importer
```

Returns a JSON object with the cookie header or an error message:
```json
{
  "cookie_header": "__Secure-next-auth.session-token=..."
}
```
