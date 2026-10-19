
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { UsageFetcher } from '../core/ports/UsageFetcher.js';
import { UsageApiError, extractWindowLabels, parseTextWindowLabels } from '../usageApi.js';

/**
 * ADAPTER (Hexagonal Architecture)
 * Implementation of the UsageFetcher port to run the external 'codexbar' CLI
 * binary as a subprocess. It resolves the executable path dynamically, invokes
 * the tool, and parses stdout/stderr into structured JS objects. Window labels
 * come from the JSON payload; older CLI versions without them fall back to a
 * second run that reads the text output.
 */
export class CliSubprocessFetcher extends UsageFetcher {
    constructor(extensionPath = null) {
        super();
        this._extensionPath = extensionPath;
    }

    /**
     * Run the command, parse the output, and resolve window labels.
     */
    async fetch(providerCommand, cancellable = null) {
        if (!providerCommand) {
            throw new UsageApiError("No command configured / No hay ningún comando configurado.");
        }

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

        let finalCommand = providerCommand;
        if (providerCommand.startsWith("codexbar") && !providerCommand.startsWith("/")) {
            finalCommand = providerCommand.replace("codexbar", executable);
        }

        // Setup launcher and custom environment (e.g. to propagate correct PATH)
        const env = GLib.get_environ();

        // Fix PATH to ensure codexbar can find the `agy` executable
        let currentPath = "";
        for (const item of env) {
            if (item.startsWith("PATH=")) {
                currentPath = item.substring(5);
                break;
            }
        }
        const userPaths = [
            `${GLib.get_home_dir()}/.local/bin`,
            "/home/linuxbrew/.linuxbrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin"
        ];
        const newPathDirs = [];
        for (const p of userPaths) {
            if (!newPathDirs.includes(p)) {
                newPathDirs.push(p);
            }
        }
        if (currentPath) {
            for (const p of currentPath.split(":")) {
                if (!newPathDirs.includes(p)) {
                    newPathDirs.push(p);
                }
            }
        }
        const newPath = newPathDirs.join(":");
        let pathFound = false;
        for (let i = 0; i < env.length; i++) {
            if (env[i].startsWith("PATH=")) {
                env[i] = `PATH=${newPath}`;
                pathFound = true;
                break;
            }
        }
        if (!pathFound) {
            env.push(`PATH=${newPath}`);
        }

        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        });
        launcher.set_environ(env);

        const [ok, argv] = GLib.shell_parse_argv(finalCommand);
        if (!ok || !argv || argv.length === 0) {
            throw new UsageApiError("Invalid command line configuration / Configuración de línea de comandos no válida.");
        }

        const proc = launcher.spawnv(argv);

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

        if (trimmedStdout && (trimmedStdout.startsWith("[") || trimmedStdout.startsWith("{"))) {
            try {
                const parsed = JSON.parse(trimmedStdout);
                const rawData = Array.isArray(parsed) ? parsed[0] : parsed;
                let labels = extractWindowLabels(rawData);
                if (labels.length === 0) {
                    labels = await this._discoverLabels(argv, env, cancellable);
                }
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

    /**
     * Fallback for CLI versions whose JSON has no rateWindowLabels: run the
     * text output once more and read the "Label: NN%" lines.
     */
    async _discoverLabels(argv, env, cancellable) {
        try {
            const discoveryArgv = argv.filter((arg, index) => {
                if (arg === "--format") return false;
                if (index > 0 && argv[index - 1] === "--format") return false;
                if (arg.startsWith("--format=")) return false;
                if (arg === "--json-only" || arg === "--json" || arg === "--json-output" || arg === "--pretty") return false;
                return true;
            });

            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            });
            launcher.set_environ(env);
            const proc = launcher.spawnv(discoveryArgv);

            const [stdout] = await new Promise((resolve) => {
                proc.communicate_utf8_async(null, cancellable, (p, res) => {
                    try {
                        const [ok, out] = p.communicate_utf8_finish(res);
                        resolve([out || ""]);
                    } catch (e) {
                        resolve([""]);
                    }
                });
            });

            return parseTextWindowLabels(stdout);
        } catch (e) {
            return [];
        }
    }
}
