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
 */
const _fallbackCache = new Map();

export function storeToken(providerId, token) {
    try {
        return Secret.password_store_sync(
            _getSchema(),
            {provider_id: providerId},
            Secret.COLLECTION_DEFAULT,
            `CodexBar token for ${providerId}`,
            token,
            null,
        );
    } catch (e) {
        console.warn(`CodexBar: Failed to store secret for ${providerId}: ${e.message}`);
        _fallbackCache.set(providerId, token);
        return false;
    }
}

export function loadToken(providerId) {
    try {
        return Secret.password_lookup_sync(_getSchema(), {provider_id: providerId}, null);
    } catch (e) {
        console.warn(`CodexBar: Failed to lookup secret for ${providerId}: ${e.message}`);
        return _fallbackCache.get(providerId) || null;
    }
}

export function clearToken(providerId) {
    _fallbackCache.delete(providerId);
    try {
        return Secret.password_clear_sync(_getSchema(), {provider_id: providerId}, null);
    } catch (e) {
        console.warn(`CodexBar: Failed to clear secret for ${providerId}: ${e.message}`);
        return false;
    }
}
