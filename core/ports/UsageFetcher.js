/**
 * PORT (Hexagonal Architecture)
 * Represents the contract/interface to fetch usage metrics from any AI provider.
 * All concrete adapters must implement this interface.
 * 
 * PUERTO (Arquitectura Hexagonal)
 * Representa el contrato/interfaz para obtener métricas de uso de cualquier proveedor de IA.
 * Todos los adaptadores concretos deben implementar esta interfaz.
 */
export class UsageFetcher {
    /**
     * Fetch usage data from the specific source (API, local server, or CLI).
     * Obtiene los datos de uso desde la fuente específica (API, servidor local o CLI).
     * 
     * @param {string|null} tokenOrCookie - Authentication token or cookie if required by the adapter.
     *                                      Token o cookie de autenticación si el adaptador lo requiere.
     * @param {object|null} extraParams - Extra options like cancellation tokens or command strings.
     *                                    Opciones adicionales como tokens de cancelación o comandos.
     * @returns {Promise<object>} The raw or simulated usage data payload.
     *                            El payload de datos de uso crudo o simulado.
     */
    async fetch(tokenOrCookie, extraParams = null) {
        throw new Error("Method 'fetch' must be implemented / El método 'fetch' debe ser implementado");
    }
}
