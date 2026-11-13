// Ask the codexbar CLI which providers are enabled, detect the provider CLIs
// that are actually installed, and enable those in codexbar.
//
// This module owns the subprocess because both Preferences and tests need the
// same binary lookup and the same bounded read. Parsing and detection stay in
// providerCatalog.js, which has no gi:// imports.

import Gio from "gi://Gio";
import GLib from "gi://GLib";

import {
  detectInstalledProviders,
  parseProviderCatalog,
} from "./providerCatalog.js";
import { PREDEFINED_PROVIDERS } from "./providerSources.js";

const DISCOVERY_TIMEOUT_SECONDS = 10;

/**
 * Locate the codexbar binary. PATH first so the user's install wins, then the
 * usual GUI-session fallbacks (Homebrew on Linux is not on the shell's PATH).
 * @returns {string|null}
 */
export function findCodexBar() {
  const fromPath = GLib.find_program_in_path("codexbar");
  if (fromPath) return fromPath;

  const candidates = [
    GLib.build_filenamev([GLib.get_home_dir(), ".local", "bin", "codexbar"]),
    "/home/linuxbrew/.linuxbrew/bin/codexbar",
    "/usr/local/bin/codexbar",
    "/usr/bin/codexbar",
  ];
  return candidates.find((path) => GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE)) || null;
}

/**
 * Run a command and return stdout, with a hard timeout.
 * @param {string[]} argv
 * @param {(stdout: string) => void} onDone
 */
function runCommand(argv, onDone) {
  let proc;
  try {
    proc = Gio.Subprocess.new(
      argv,
      Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
    );
  } catch (e) {
    onDone("");
    return;
  }

  let done = false;
  let timeoutId = 0;
  const complete = (stdout) => {
    if (done) return;
    done = true;
    if (timeoutId) {
      GLib.source_remove(timeoutId);
      timeoutId = 0;
    }
    onDone(stdout || "");
  };

  timeoutId = GLib.timeout_add_seconds(
    GLib.PRIORITY_DEFAULT,
    DISCOVERY_TIMEOUT_SECONDS,
    () => {
      timeoutId = 0;
      proc.force_exit();
      complete("");
      return GLib.SOURCE_REMOVE;
    },
  );

  proc.communicate_utf8_async(null, null, (source, result) => {
    try {
      const [, stdout] = source.communicate_utf8_finish(result);
      complete(stdout);
    } catch (e) {
      complete("");
    }
  });
}

/**
 * Enable every detected provider.
 *
 * `config enable` accepts one provider at a time. Each id is spawned as a
 * plain argv entry (no shell), so a provider id can never be interpreted as
 * shell source and EGO reviewers do not have to audit a `sh -c` command.
 *
 * @param {string} bin
 * @param {string[]} ids
 * @param {() => void} onDone
 */
function enableProviders(bin, ids, onDone) {
  if (ids.length === 0) {
    onDone();
    return;
  }

  let remaining = ids.length;
  for (const id of ids) {
    runCommand([bin, "config", "enable", "--provider", id], () => {
      remaining -= 1;
      if (remaining === 0) onDone();
    });
  }
}

/**
 * Discover the providers the extension should have configured.
 *
 * This is intentionally not just `config providers`: a provider CLI can be
 * installed and logged in while its codexbar toggle is still off. Those are
 * enabled in codexbar here, then returned together with the already-enabled
 * ones. Failures and timeouts degrade to the enabled list.
 *
 * @param {(providers: Array<{id: string, name: string}>) => void} onDone
 * @param {{skipIds?: string[]}} options Providers the user deliberately removed
 */
export function discoverEnabledProviders(onDone, { skipIds = [] } = {}) {
  const finish = (providers) => onDone(Array.isArray(providers) ? providers : []);
  const skipped = new Set(Array.isArray(skipIds) ? skipIds : []);

  const bin = findCodexBar();
  if (!bin) {
    finish([]);
    return;
  }

  runCommand([bin, "config", "providers", "--format", "json"], (stdout) => {
    const catalog = parseProviderCatalog(stdout);
    const enabled = catalog
      .filter((entry) => entry.enabled)
      .map(({ id, name }) => ({ id, name }));

    const installed = detectInstalledProviders(PREDEFINED_PROVIDERS, {
      hasCommand: (command) => Boolean(GLib.find_program_in_path(command)),
      hasPath: (path) =>
        GLib.file_test(
          GLib.build_filenamev([GLib.get_home_dir(), ...path.split("/")]),
          GLib.FileTest.EXISTS,
        ),
    });

    const knownIds = new Set(
      catalog.length > 0
        ? catalog.map((entry) => entry.id)
        : PREDEFINED_PROVIDERS.map((entry) => entry.id),
    );
    const enabledIds = new Set(enabled.map((entry) => entry.id));
    const toEnable = installed.filter(
      (entry) =>
        knownIds.has(entry.id) &&
        !enabledIds.has(entry.id) &&
        !skipped.has(entry.id),
    );

    const merged = () => {
      const byId = new Map();
      for (const provider of [...enabled, ...installed]) {
        if (!byId.has(provider.id)) byId.set(provider.id, provider);
      }
      finish([...byId.values()]);
    };

    enableProviders(
      bin,
      toEnable.map((provider) => provider.id),
      merged,
    );
  });
}
