# CodexBar for GNOME  

> FEATURED on Codexbar Official repo!

The best GNOME Shell extension to use Codexbar. The most used Codexbar port for GNOME. Feel free to contribute and join our community (links below)

![CodexBar Panel](<demo.gif>)    
(TO DO: Update this image)

## Features

- Shows remaining usage/spent + economic expense/remaining
- Supports a large number of providers + you can add yours
- Refreshes according to the interval you configure
- Supports different information extraction methods depending on provider
- You can show the individual usage of each one in the top bar / show the general summary
- Indicates what time the usage will restart
- Calculate if it will be enough for your day of use
- It is translated and you can translate it to your language
- **And much more**

---
## Discover my main project [Pulsar OS](https://os.inled.es), which I am dedicating more time to and has a great friendly community for beginners and professionals! It's already on Distrowatch!
---
## Join the Community

We are a Linux community where everyone is welcome, from beginners to professionals, without ideology or elitism. Join us!

- **Discord**: [Join us on Discord!](https://link.inled.es/discord)
- **Telegram**: [Join us on Telegram!](https://link.inled.es/telegram)
- **Matrix**: [Join the Matrix server](https://matrix.inled.es)
- **YouTube**: [Inled Group YouTube Channel](https://www.youtube.com/@inledgroup)
- **X (Twitter)**: [@inledgroup on X](https://x.com/inledgroup)


## Updates  
- Added translations
- Merged a lot of really good pr's!

## Requirements

The extension requires the CodexBar CLI tool installed on your system.

### Install CodexBar CLI

It is recommended to install the CLI via Homebrew, which is the official way:

```bash
brew install steipete/tap/codexbar
```
Homebrew exists for Linux (and is a good package manager). For those who don't know, it can be installed with
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### Install Cookie Importer (only for Codex users)
It is now distributed separately from the extension and no longer requires PyPI. Download it directly from the repo into `~/.local/bin` (the extension looks there by default):
```bash
mkdir -p ~/.local/bin && curl -fsSL https://raw.githubusercontent.com/InledGroup/codexbar-gnome/main/scripts/codexbar-cookie-importer -o ~/.local/bin/codexbar-cookie-importer && chmod +x ~/.local/bin/codexbar-cookie-importer
```
It is a dependency-free bash script (uses `secret-tool`, `openssl`, `sqlite3`).

### Install helper to Trust the Certificate of the Antigravity Language Server (only for Antigravity users)
This minimal script is invoked by the extension when you click on the trust antigravity cert button and what it does is save the certificate in the system trust store, elevating privileges.   
Since it elevates privileges, it would be unreasonable to integrate the elevation logic into the extension (as JustPerfection told me) so it is served as a standalone script that the user must decide to install, thus complying with GJS guidelines. It is now a dependency-free bash script (no PyPI):

```bash
mkdir -p ~/.local/bin && curl -fsSL https://raw.githubusercontent.com/InledGroup/codexbar-gnome/main/scripts/codexbar-ssl-helper -o ~/.local/bin/codexbar-ssl-helper && chmod +x ~/.local/bin/codexbar-ssl-helper && codexbar-ssl-helper
```


## Installation

### From EGO
You can download it from the official GNOME store. It takes longer to be updated.
[https://extensions.gnome.org/extension/9841/codexbar/](https://extensions.gnome.org/extension/9841/codexbar/)

### From Github  
1. Clone or fork the repo
2. Run the `./install` script
3. - On Wayland:
      - Log out and log in
      - **For fast development and iteration**: Run `dbus-run-session gnome-shell --wayland --devkit`. You need to have installed Mutter Devkit
   - On X11: `Alt+F2` and type `r` and press enter.

### From Pulsar Store  
[Coming soon](https://store-os.inled.es)

## Configuration

Access the settings through the gear icon in the extension menu or using your extension manager client.

### Provider Commands

Each provider must be configured with a command that returns JSON output.

Example for Gemini:
```bash
codexbar --provider gemini --source api --format json
```

The extension will automatically attempt to locate the `codexbar` binary in common locations such as `/home/linuxbrew/.linuxbrew/bin/` if an absolute path is not provided. 

Certain vendors have specific fields in Codexbar CLI, whose interpretation may not have been implemented so this is a great opportunity for you to implement support (if you want) and do a PR.

### API Keys (e.g. OpenRouter)

Some providers (OpenRouter with `--source api`) authenticate the CodexBar CLI via an environment variable, e.g. `OPENROUTER_API_KEY`, instead of a token cached on disk. Setting that variable in `~/.zshrc`, `~/.bashrc`, or similar is **not enough**: GNOME Shell is started by your login/display manager, not by an interactive shell, so it never sources your shell's dotfiles, and any command the extension runs (as a child process of GNOME Shell) inherits GNOME Shell's environment, not your terminal's.

To make the variable visible to the extension, add it to your systemd user environment instead:

```bash
mkdir -p ~/.config/environment.d
echo 'OPENROUTER_API_KEY=sk-or-v1-...' > ~/.config/environment.d/codexbar.conf
chmod 600 ~/.config/environment.d/codexbar.conf
```

Then log out and log back in. `environment.d` files are only read once, when your `systemd --user` manager starts — if it's still running from before you added the file (e.g. lingering is enabled: `loginctl show-user $USER | grep Linger`), a normal logout/login won't pick it up. In that case, apply it to the running instance once, then log out/in as usual:

```bash
systemctl --user import-environment OPENROUTER_API_KEY
```

You can confirm GNOME Shell actually has the variable with:

```bash
tr '\0' '\n' < /proc/$(pgrep -x gnome-shell)/environ | grep OPENROUTER_API_KEY
```

Without it, `codexbar --provider openrouter --source api` still returns valid JSON, but with a top-level `error` field and no `usage.details` — so the OpenRouter tab shows only a bare, empty tier instead of the Credits / API key / Spend history breakdown.

### Display Mode

You can choose how metrics are displayed:
- **Remaining**: Shows the percentage of quota left (default).
- **Used**: Shows the percentage of quota consumed.

### OpenCode and OpenCode Go on Linux

Open **CodexBar Preferences → AI Providers**, enable **OpenCode** or **OpenCode Go**,
and leave **Connection** on **Direct API (session cookies)**. These entries are
disabled until you enable them. OpenCode refers to the hosted Zen/Console account;
it does not aggregate other providers you use inside the OpenCode app.

1. Sign in to [OpenCode Console](https://opencode.ai/console) in Chrome, Brave, or
   Edge. Native and Flatpak Chrome/Edge profile locations are recognized.
2. Install/update the repository's `scripts/codexbar-cookie-importer` in
   `~/.local/bin`, then click **Auto-Login from Browser**. The helper requires
   `openssl`, `sqlite3`, and `secret-tool`. It supports the existing Linux v10/v11
   browser encryption format when the browser's Safe Storage key is accessible.
   Other browser encryption/keyring configurations may require manual entry.
3. Alternatively, copy the `__Host-console_session` cookie from the Console's
   browser developer tools and enter `__Host-console_session=VALUE` in the password
   field. Credentials are stored in the desktop keyring, never in provider settings.
4. With one workspace, discovery is automatic. With multiple workspaces, enter
   its `org_…` or `wrk_…` ID from the Console URL in **Workspace ID**. No accounts
   are combined or selected arbitrarily. Each provider can use its own workspace.

Go shows the reported five-hour, weekly, and monthly subscription meters. Missing
resets remain unknown. **Zen balance** is shown separately, including zero or
negative balances. OpenCode PAYG accounts show **Last 30 days** spend and their
available balance; they do not get a fabricated quota percentage. A successful
response without a Go subscription displays that state explicitly.

Direct API uses the current Console JSON endpoints and works without the
CodexBar CLI's browser integration. Optional CLI mode uses the distinct IDs
`opencode` and `opencodego`; verify both with `codexbar --help` (tested with
0.78.0). In that version the base OpenCode CLI web source requires macOS, so use
Direct API on Linux. Legacy-only sessions must sign in to the current Console.
Expired sessions require importing cookies again.

For a specific browser profile, the helper also accepts
`--provider opencodego --profile /absolute/path/to/Cookies`. Console cookies are
read from a single profile, with exact cookie-name and domain matching.

The OpenCode symbolic icons are adapted from
[CodexBar v0.78.0](https://github.com/steipete/CodexBar/tree/v0.78.0/Sources/CodexBar/Resources)
under its MIT license (included in `media/logos/OpenCode-LICENSE.txt`). This
extension remains based on the original InledGroup/codexbar-gnome project.



## License

This project is licensed under [MIT-INLED](https://license.inled.es). Click on the name to see the license.

> [!WARNING]
> If you base your code on ours or remix it using AI, you must credit the original repository out of respect for the contributors and the creator.



> [!NOTE]
> **ABOUT AI**  
> AI is used to develop this project and we accept contributions with AI as long as you review what the AI ​​does, have tested it and do not rewrite many lines of code, and the PR and Issues must be written by a human, simply so that you are not talking to an AI that you do not know if it is AI or human. Our community is friendly, without ideology or politics, and you can join us on the channels described above. Being against positioning ourselves ideologically, we are not against AI, so its use is welcome
