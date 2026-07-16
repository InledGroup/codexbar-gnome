import Secret from 'gi://Secret';

const SECRET_SCHEMA_NAME = 'org.gnome.shell.extensions.codexbar.token';

// Lazily initialize the schema to avoid creating GObject instances before enable()
// Inicializar el esquema de forma perezosa (lazy) para evitar crear instancias de GObject antes de enable()
let _tokenSchema = null;

function _getSchema() {
    if (!_tokenSchema) {
        _tokenSchema = new Secret.Schema(
            SECRET_SCHEMA_NAME,
            Secret.SchemaFlags.NONE,
            {provider_id: Secret.SchemaAttributeType.STRING},
        );
    }
    return _tokenSchema;
}

/**
 * In-memory fallback for cases where the secret service is unavailable
 * (e.g., nested Wayland sessions or CI environments).
 * Experimental
 */
const _fallbackCache = new Map();

export function storeToken(providerId, token) {
    return new Promise((resolve) => {
        Secret.password_store(
            _getSchema(),
            {provider_id: providerId},
            Secret.COLLECTION_DEFAULT,
            `CodexBar token for ${providerId}`,
            token,
            null,
            (source, result) => {
                try {
                    const success = Secret.password_store_finish(result);
                    resolve(success);
                } catch (e) {
                    console.warn(`CodexBar: Failed to store secret for ${providerId}: ${e.message}`);
                    _fallbackCache.set(providerId, token);
                    resolve(false);
                }
            }
        );
    });
}

export function loadToken(providerId) {
    return new Promise((resolve) => {
        Secret.password_lookup(
            _getSchema(),
            {provider_id: providerId},
            null,
            (source, result) => {
                try {
                    const token = Secret.password_lookup_finish(result);
                    resolve(token);
                } catch (e) {
                    console.warn(`CodexBar: Failed to lookup secret for ${providerId}: ${e.message}`);
                    resolve(_fallbackCache.get(providerId) || null);
                }
            }
        );
    });
}

export function clearToken(providerId) {
    _fallbackCache.delete(providerId);
    return new Promise((resolve) => {
        Secret.password_clear(
            _getSchema(),
            {provider_id: providerId},
            null,
            (source, result) => {
                try {
                    const success = Secret.password_clear_finish(result);
                    resolve(success);
                } catch (e) {
                    console.warn(`CodexBar: Failed to clear secret for ${providerId}: ${e.message}`);
                    resolve(false);
                }
            }
        );
    });
}

/**
 * Release the token schema reference and clear the fallback cache to prevent memory leaks on disable.
 * Libera la referencia del esquema del token y limpia la caché de respaldo para evitar fugas de memoria al desactivar.
 */
export function nullTokenSchema() {
    _tokenSchema = null;
    _fallbackCache.clear();
}

