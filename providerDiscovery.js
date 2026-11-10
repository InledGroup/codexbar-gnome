// Ask the codexbar CLI which providers are enabled.
//
// This module owns the subprocess because both Preferences and tests need the
// same binary lookup and the same bounded read. Parsing stays in
// providerCatalog.js, which has no gi:// imports.

import Gio from "gi://Gio";
import GLib from "gi://GLib";

import { parseConfigProviders } from "./providerCatalog.js";

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
 * Read the enabled providers without blocking the caller.
 *
 * `config providers` only reads the CLI's config file, so it is much cheaper
 * than a usage query. Failures and timeouts return an empty list: discovery is
 * a convenience, never a requirement for the extension to work.
 *
 * @param {(providers: Array<{id: string, name: string}>) => void} onDone
 */
export function discoverEnabledProviders(onDone) {
  const finish = (providers) => onDone(Array.isArray(providers) ? providers : []);

  const bin = findCodexBar();
  if (!bin) {
    finish([]);
    return;
  }

  let proc;
  try {
    proc = Gio.Subprocess.new(
      [bin, "config", "providers", "--format", "json"],
      Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
    );
  } catch (e) {
    finish([]);
    return;
  }

  let done = false;
  let timeoutId = 0;
  const complete = (providers) => {
    if (done) return;
    done = true;
    if (timeoutId) {
      GLib.source_remove(timeoutId);
      timeoutId = 0;
    }
    finish(providers);
  };

  timeoutId = GLib.timeout_add_seconds(
    GLib.PRIORITY_DEFAULT,
    DISCOVERY_TIMEOUT_SECONDS,
    () => {
      timeoutId = 0;
      proc.force_exit();
      complete([]);
      return GLib.SOURCE_REMOVE;
    },
  );

  proc.communicate_utf8_async(null, null, (source, result) => {
    try {
      const [, stdout] = source.communicate_utf8_finish(result);
      complete(parseConfigProviders(stdout));
    } catch (e) {
      complete([]);
    }
  });
}
