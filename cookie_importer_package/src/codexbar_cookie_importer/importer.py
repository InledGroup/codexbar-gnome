import os
import sqlite3
import json
import shutil
import glob
import re

# Dependencies / Dependencias
try:
    import secretstorage
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    HAS_DEPS = True
except ImportError:
    HAS_DEPS = False

CHROMIUM_SECRET_SCHEMA = "chrome_libsecret_os_crypt_password_v2"
GENERIC_SECRET_SCHEMA = "org.freedesktop.Secret.Generic"

PROVIDER_CONFIGS = {
    "codex": {
        "display_name": "ChatGPT/OpenAI",
        "domains": ["chatgpt.com", "openai.com"],
        "targets": ["session-token", "oai-did", "oai-sc", "cf_clearance", "_cf_bm", "oai-is", "oai-allow", "oai-chat-web-route", "oai-client-auth-info"],
        "required_cookie": "session-token",
        "priority_cookies": ["session-token"],
    },
    "ollama": {
        "display_name": "Ollama",
        "domains": ["ollama.com"],
        "targets": [],
        "required_cookie": None,
        "priority_cookies": ["session", "auth", "token"],
    },
}

def get_keys(label_hints, app_names=None, app_ids=None):
    """
    Retrieve decryption keys from the Linux keyring (D-Bus / SecretStorage).
    Recupera las claves de descifrado del llavero de Linux (D-Bus / SecretStorage).
    """
    keys = []
    seen = set()
    errors = []
    app_names = {name.lower() for name in (app_names or [])}
    app_ids = {app_id.lower() for app_id in (app_ids or [])}

    def add_secret(secret):
        if secret not in seen:
            keys.append(secret)
            seen.add(secret)

    def item_priority(item):
        try:
            attrs = item.get_attributes()
        except Exception:
            attrs = {}
        app = attrs.get("application", "").lower()
        app_id = attrs.get("app_id", "").lower()
        schema = attrs.get("xdg:schema", "")
        if app in app_names and schema == CHROMIUM_SECRET_SCHEMA:
            return 0
        if app_id in app_ids and schema in {CHROMIUM_SECRET_SCHEMA, GENERIC_SECRET_SCHEMA}:
            return 0

        label = item.get_label().lower()
        if any(hint.lower() in label for hint in label_hints):
            # Chromium creates "Safe Storage Control" dummy entries to test
            # keyring unlock behavior. They are not cookie encryption keys.
            # / Chromium crea entradas ficticias "Safe Storage Control" para probar
            # el desbloqueo del keyring. No son claves de cifrado de cookies.
            if "control" in label:
                return None
            return 1

        return None

    def scan_collection(collection):
        try:
            if collection.is_locked():
                collection.unlock()
        except Exception as e:
            errors.append(f"unlock failed: {e}")

        matched = []
        try:
            items = collection.get_all_items()
        except Exception as e:
            errors.append(f"items failed: {e}")
            return

        for item in items:
            try:
                priority = item_priority(item)
                if priority is not None:
                    matched.append((priority, item))
            except Exception as e:
                errors.append(f"item read failed: {e}")

        for _priority, item in sorted(matched, key=lambda pair: pair[0]):
            try:
                add_secret(item.get_secret())
            except Exception as e:
                errors.append(f"secret read failed: {e}")

    try:
        bus = secretstorage.dbus_init()
        for app_name in app_names:
            try:
                for item in secretstorage.search_items(bus, {
                    "application": app_name,
                    "xdg:schema": CHROMIUM_SECRET_SCHEMA,
                }):
                    add_secret(item.get_secret())
            except Exception as e:
                errors.append(f"search {app_name}: {e}")

        for app_id in app_ids:
            for schema in (CHROMIUM_SECRET_SCHEMA, GENERIC_SECRET_SCHEMA):
                try:
                    for item in secretstorage.search_items(bus, {
                        "app_id": app_id,
                        "xdg:schema": schema,
                    }):
                        add_secret(item.get_secret())
                except Exception as e:
                    errors.append(f"search {app_id}: {e}")

        try:
            scan_collection(secretstorage.get_default_collection(bus))
        except Exception as e:
            errors.append(f"default collection: {e}")

        if not keys:
            try:
                for collection in secretstorage.get_all_collections(bus):
                    scan_collection(collection)
            except Exception as e:
                errors.append(f"all collections: {e}")
    except Exception as e:
        errors.append(str(e))
    
    found_keyring_keys = bool(keys)
    if b"peanuts" not in seen:
        keys.append(b"peanuts")
    return keys, None if found_keyring_keys else ("; ".join(dict.fromkeys(errors)) or None)

def decrypt_v10(encrypted_value, key):
    """
    Decrypt cookie value encrypted with v10/v11 protocol.
    Descifra el valor de la cookie encriptada con el protocolo v10/v11.
    """
    if not encrypted_value or len(encrypted_value) < 3:
        return None
        
    if not encrypted_value.startswith(b"v10") and not encrypted_value.startswith(b"v11"):
        return None
        
    try:
        salt = b"saltysalt"
        iv = b" " * 16
        kdf = PBKDF2HMAC(algorithm=hashes.SHA1(), length=16, salt=salt, iterations=1)
        derived_key = kdf.derive(key)
        
        cipher = Cipher(algorithms.AES(derived_key), modes.CBC(iv))
        decryptor = cipher.decryptor()
        decrypted = decryptor.update(encrypted_value[3:]) + decryptor.finalize()
        
        # Chromium Linux v10/v11 values use PKCS#7 padding with AES-CBC.
        # If padding is invalid, the key is almost certainly wrong.
        # / Los valores de Chromium en Linux v10/v11 usan padding PKCS#7 con AES-CBC.
        # Si el padding no es válido, la clave es casi seguro incorrecta.
        padding_len = decrypted[-1]
        if padding_len < 1 or padding_len > 16:
            return None
        if not all(decrypted[i] == padding_len for i in range(-padding_len, 0)):
            return None
        decrypted_unpadded = decrypted[:-padding_len]

        # Handle v11 / v10 header/garbage / Manejar cabecera/basura de v11 / v10
        # Try to find JWT start / Intentar encontrar el inicio del JWT
        jwt_start = decrypted_unpadded.find(b'eyJ')
        if jwt_start != -1 and jwt_start < 48:
            res = decrypted_unpadded[jwt_start:]
        else:
            # Try common header offsets for v11 / Intentar offsets de cabecera comunes para v11
            found_clean = False
            for offset in [32, 28, 0]:
                if len(decrypted_unpadded) > offset:
                    candidate = decrypted_unpadded[offset:]
                    # Check if the first 10 chars are printable (ASCII) / Comprobar si los primeros 10 caracteres son imprimibles (ASCII)
                    if len(candidate) >= 10 and all(32 <= c <= 126 for c in candidate[:10]):
                        res = candidate
                        found_clean = True
                        break
            if not found_clean:
                res = decrypted_unpadded

        # Final cleanup: decode and handle padding/garbage / Limpieza final: decodificar y manejar padding/basura
        res_str = res.decode('utf-8')
        if not is_plausible_cookie_value("", res_str):
            return None
            
        return res_str
    except:
        return None

def is_plausible_cookie_value(name, value):
    """
    Validate cookie content to ensure it conforms to acceptable formats.
    Valida el contenido de la cookie para asegurar que cumple con los formatos aceptables.
    """
    if not value:
        return False

    # RFC6265 cookie-octet, excluding DQUOTE, comma, semicolon, backslash,
    # whitespace, and control characters. Wrong decryption often produces these.
    # / Octeto de cookie RFC6265, excluyendo DQUOTE, coma, punto y coma, barra invertida,
    # espacios en blanco y caracteres de control. La descodificación errónea suele producirlos.
    if not re.fullmatch(r"[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+", value):
        return False

    # A chunked NextAuth session token may end with a short final chunk (for
    # example, ``__Secure-next-auth.session-token.1``). Only enforce the
    # minimum length for an unchunked token; dropping a short chunk makes the
    # reconstructed cookie invalid.
    if "session-token" in name and not re.search(r"\.\d+$", name) and len(value) < 100:
        return False

    return True

def extract_tokens(provider="codex"):
    """
    Extract provider cookies from local browser profiles.
    Extrae cookies del proveedor desde los perfiles de los navegadores locales.
    """
    if not HAS_DEPS:
        return {"error": "DEPENDENCIES_MISSING"}

    provider = (provider or "codex").lower()
    config = PROVIDER_CONFIGS.get(provider)
    if not config:
        return {"error": "UNSUPPORTED_PROVIDER", "details": f"Unsupported provider: {provider}"}

    browsers = [
        {
            "name": "Chrome",
            "path": "~/.config/google-chrome/*/Cookies",
            "key_labels": ["Chrome Safe Storage"],
            "app_names": ["chrome"],
        },
        {
            "name": "Brave",
            "path": "~/.config/BraveSoftware/Brave-Browser/*/Cookies",
            "key_labels": ["Brave Safe Storage"],
            "app_names": ["brave"],
        },
        {
            "name": "Chromium",
            "path": "~/.config/chromium/*/Cookies",
            "key_labels": ["Chromium Safe Storage", "Application key for org.chromium.Chromium"],
            "app_names": ["chromium"],
        },
        {
            "name": "Vivaldi",
            "path": "~/.config/vivaldi/*/Cookies",
            "key_labels": ["Vivaldi Safe Storage"],
            "app_names": ["vivaldi"],
        },
        {
            "name": "Vivaldi Flatpak",
            "path": "~/.var/app/com.vivaldi.Vivaldi/config/vivaldi/*/Cookies",
            "key_labels": ["Vivaldi Safe Storage", "Chrome Safe Storage"],
            "app_names": ["vivaldi", "com.vivaldi.Vivaldi", "chrome"],
            "app_ids": ["com.vivaldi.Vivaldi"],
        },
    ]

    targets = config["targets"]
    
    all_cookies = {}
    dbus_errors = []
    encrypted_targets = 0
    
    for browser in browsers:
        keys, dbus_err = get_keys(browser["key_labels"], browser.get("app_names"), browser.get("app_ids"))
        if dbus_err:
            dbus_errors.append(f"{browser['name']}: {dbus_err}")
            
        search_path = os.path.expanduser(browser["path"])
        cookie_files = glob.glob(search_path)
        
        if not cookie_files:
            continue

        for db_path in cookie_files:
            temp_db = None
            try:
                temp_db = f"/tmp/codexbar_cookies_{os.getpid()}.db"
                # Check if we can read the source file / Comprobar si podemos leer el archivo de origen
                if not os.access(db_path, os.R_OK):
                    return {"error": "PERMISSION_DENIED", "details": f"Cannot read cookie file at {db_path}. Try closing your browser."}

                shutil.copyfile(db_path, temp_db)
                conn = sqlite3.connect(f"file:{temp_db}?mode=ro", uri=True)
                cursor = conn.cursor()
                
                where = " OR ".join(["host_key LIKE ?" for _domain in config["domains"]])
                params = [f"%{domain}%" for domain in config["domains"]]
                cursor.execute(f"SELECT name, value, encrypted_value FROM cookies WHERE {where}", params)
                
                for name, value, enc_val in cursor.fetchall():
                    if targets and not any(t in name for t in targets):
                        continue

                    if enc_val:
                        encrypted_targets += 1

                    cookie_value = value if is_plausible_cookie_value(name, value) else None

                    if cookie_value is None:
                        for key in keys:
                            cookie_value = decrypt_v10(enc_val, key)
                            if cookie_value is not None and is_plausible_cookie_value(name, cookie_value):
                                break
                            cookie_value = None

                    if cookie_value:
                        all_cookies[name] = cookie_value
                
                conn.close()
            except Exception as e:
                return {"error": "DATABASE_ERROR", "details": str(e)}
            finally:
                if temp_db and os.path.exists(temp_db): 
                    os.remove(temp_db)

    if not all_cookies:
        details = f"Found no valid {config['display_name']} cookies. Please ensure you are logged in."
        if encrypted_targets:
            details += (
                f"\n\nFound {encrypted_targets} encrypted {config['display_name']} cookies, "
                "but none could be decrypted with the available browser keyring keys."
            )
        if dbus_errors:
            details += "\n\nKeyring access errors (D-Bus):\n" + "\n".join(dbus_errors)
        return {"error": "SESSION_NOT_FOUND", "details": details}

    required_cookie = config.get("required_cookie")
    if required_cookie and not any(required_cookie in name for name in all_cookies):
         return {"error": "SESSION_NOT_FOUND", "details": f"Found some cookies but no {required_cookie}. Please log in."}

    # Format the cookie header / Dar formato a la cabecera de la cookie
    # Priority cookies first, then others / Cookies prioritarias primero, luego otras
    priority_cookies = config.get("priority_cookies", [])
    session_parts = [f"{name}={val}" for name, val in sorted(all_cookies.items()) if any(priority in name for priority in priority_cookies)]
    other_parts = [f"{name}={val}" for name, val in sorted(all_cookies.items()) if not any(priority in name for priority in priority_cookies)]
    
    cookie_parts = session_parts + other_parts
    
    header = "; ".join(cookie_parts)
    return {"cookie_header": header}
