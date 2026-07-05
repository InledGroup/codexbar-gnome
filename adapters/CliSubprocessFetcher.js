import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { UsageFetcher } from '../core/ports/UsageFetcher.js';
import { UsageApiError } from '../usageApi.js';

/**
 * ADAPTER (Hexagonal Architecture)
 * Implementation of the UsageFetcher port to run the external 'codexbar' CLI
 * binary as a subprocess. It resolves the executable path dynamically, invokes
 * the tool, and parses stdout/stderr into structured JS objects. It also runs a
 * quick discovery pass to read the text labels for the provider's active windows.
 * 
 * ADAPTADOR (Arquitectura Hexagonal)
 * Implementación del puerto UsageFetcher para ejecutar el binario de terminal externo
 * 'codexbar' como un subproceso. Resuelve la ruta del ejecutable dinámicamente, invoca
 * la herramienta y parsea stdout/stderr en objetos JS estructurados. También realiza
 * una consulta rápida de descubrimiento para leer las etiquetas de texto de las ventanas.
 */
export class CliSubprocessFetcher extends UsageFetcher {
    constructor() {
        super();
    }

    /**
     * Run the command, parse the output, and discover labels.
     * Ejecuta el comando, parsea la salida y descubre las etiquetas.
     * 
     * @param {string} providerCommand - The CLI command configured for the provider.
     *                                   El comando CLI configurado para el proveedor.
     * @param {Gio.Cancellable|null} cancellable - Token to cancel the subprocess.
     *                                             Token para cancelar el subproceso.
     * @returns {Promise<object>} Parsed data, labels array, and the final command executed.
     *                            Datos parseados, array de etiquetas y el comando final ejecutado.
     */
    async fetch(providerCommand, cancellable = null) {
        if (!providerCommand) {
            throw new UsageApiError("No command configured / No hay ningún comando configurado.");
        }

        // Step 1: Resolve the absolute path of the 'codexbar' executable.
        // Paso 1: Resolver la ruta absoluta del ejecutable 'codexbar'.
        let executable = "/home/linuxbrew/.linuxbrew/bin/codexbar";
        const commonPaths = [
            "/home/linuxbrew/.linuxbrew/bin/codexbar",
            `${GLib.get_home_dir()}/.local/bin/codexbar`,
            "/usr/local/bin/codexbar",
            "/usr/bin/codexbar",
        ];

        for (const path of commonPaths) {
            if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
                executable = path;
                break;
            }
        }

        // Replace the generic 'codexbar' prefix with the resolved absolute path
        // Reemplazar el prefijo genérico 'codexbar' con la ruta absoluta resuelta
        let finalCommand = providerCommand;
        if (providerCommand.startsWith("codexbar") && !providerCommand.startsWith("/")) {
            finalCommand = providerCommand.replace("codexbar", executable);
        }

        // Step 2: Spawn the subprocess to execute the CLI tool
        // Paso 2: Lanzar el subproceso para ejecutar la herramienta CLI
        const proc = Gio.Subprocess.new(
            ["bash", "-c", finalCommand],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        );

        const [stdout, stderr] = await new Promise((resolve, reject) => {
            proc.communicate_utf8_async(null, cancellable, (p, res) => {
                try {
                    const [ok, out, err] = p.communicate_utf8_finish(res);
                    resolve([out || "", err || ""]);
                } catch (e) {
                    if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                        resolve(["", ""]);
                    } else {
                        reject(e);
                    }
                }
            });
        });

        const trimmedStdout = stdout.trim();
        const trimmedStderr = stderr.trim();

        // Step 3: Automatic label detection (run command in text mode to parse names)
        // Paso 3: Detección automática de etiquetas (ejecutar en modo texto para leer nombres)
        let labels = [];
        try {
            let discoveryCommand = finalCommand
                .replace("--format json", "")
                .replace("--json-only", "")
                .replace("--json", "")
                .replace("--pretty", "");

            const dProc = Gio.Subprocess.new(
                ["bash", "-c", discoveryCommand],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );

            const [dStdout] = await new Promise((resolve) => {
                dProc.communicate_utf8_async(null, cancellable, (p, res) => {
                    try {
                        const [ok, out] = p.communicate_utf8_finish(res);
                        resolve([out || ""]);
                    } catch (e) {
                        resolve([""]);
                    }
                });
            });

            if (dStdout) {
                const lines = dStdout.split("\n");
                for (let line of lines) {
                    const match = line.match(/^([^:]+):\s+\d+%/);
                    if (match) {
                        labels.push(match[1].trim());
                    }
                }
            }
        } catch (e) {
            // Ignore label discovery failures / Ignorar fallos de descubrimiento de etiquetas
        }

        // Step 4: Parse the JSON stdout or format errors
        // Paso 4: Parsear la salida JSON (stdout) o formatear errores
        if (trimmedStdout && (trimmedStdout.startsWith("[") || trimmedStdout.startsWith("{"))) {
            try {
                const parsed = JSON.parse(trimmedStdout);
                const rawData = Array.isArray(parsed) ? parsed[0] : parsed;
                return {
                    data: rawData,
                    labels: labels,
                    command: finalCommand
                };
            } catch (e) {
                throw new UsageApiError(`JSON Error / Error JSON: ${e.message}`);
            }
        } else if (trimmedStderr) {
            throw new UsageApiError(`CLI Error / Error de CLI: ${trimmedStderr.split("\n")[0]}`);
        } else if (trimmedStdout) {
            throw new UsageApiError("Output is not valid JSON / La salida no es un JSON válido");
        } else {
            throw new UsageApiError("No output from command / Sin respuesta del comando");
        }
    }
}
