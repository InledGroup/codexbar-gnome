/* SPDX-License-Identifier: GPL-2.0-or-later
 * PORT (Hexagonal Architecture)
 * Represents the contract/interface to fetch usage metrics from any AI provider.
 * All concrete adapters must implement this interface.
 */
export class UsageFetcher {
    /**
     * Fetch usage data from the specific source (API, local server, or CLI).
     *
     * @param {string|null} tokenOrCookie - Authentication token or cookie if required by the adapter.
     * @param {object|null} extraParams - Extra options like cancellation tokens or command strings.
     * @returns {Promise<object>} The raw or mocked usage data payload.
     */
    async fetch(tokenOrCookie, extraParams = null) {
        throw new Error("Method 'fetch' must be implemented.");
    }
}
