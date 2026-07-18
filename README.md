# CodexBar for GNOME

A GNOME Shell extension to monitor AI provider usage metrics directly from the system panel. This extension acts as a graphical interface for the CodexBar CLI, providing real-time visibility into your API quotas and usage tiers.

![CodexBar Panel](<demo.gif>)

## Features

- Real-time monitoring of AI provider usage (Gemini, OpenAI, etc).
- Support for multiple usage tiers
- Toggle between Remaining Quota and Used Quota display modes.
- Automatic background refreshes with configurable intervals.
- Visual warnings (color changes) when reaching quota limits.
- Automatic resolution of CodexBar CLI paths (Homebrew supported).

## Updates  
- Recovered the cookie_importer folder, deleted by mistake in commit `fec55b0`
- show the Codex account plan and available limit-reset credits
- calculate and display weekly usage pace from the existing quota window
- render Code review usage when the Linux API supplies it
- add regression coverage for the new normalization and pace calculation
- added support to show AI economic expenditure

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
It is now distributed separately from the extension.  
```bash
pip install codexbar-cookie-importer
```

### Install helper to Trust the Certificate of the Antigravity Language Server (only for Antigravity users)
This minimal Python script is invoked by the extension when you click on the trust antigravity cert button and what it does is save it in the gnome keyring, elevating privileges.   
Since it elevates privileges, it would be unreasonable to integrate the elevation logic into the extension (as JustPerfection told me) so it is served as a standalone python package that the user must decide to install, thus complying with GJS guidelines.

```bash
pip install codexbar-ssl-helper

```


## Installation

### From EGO
Reviewed by the great GNOME experts, with the confidence of correct operation and stability.
[https://extensions.gnome.org/extension/9841/codexbar/](https://extensions.gnome.org/extension/9841/codexbar/)

### From Github  
1. Clone or fork the repo
2. Run the `./install` script
3. - On Wayland:
      - Log out and log in
      - **For fast development and iteration**: Run `dbus-run-session gnome-shell --wayland --devkit`. You need to have installed Mutter Devkit
   - On X11: `Alt+F2` and type `r` and press enter.

### From Unofficial Gnome Shell Store
I am working on a very interesting concept to present, which is the automated review of extensions with AI. 
The package is not updated very regularly, the site is still a concept, but it can be tested [https://extensions-gnome.github.io/?ext=codexbar%40inled.es](https://extensions-gnome.github.io/?ext=codexbar%40inled.es)

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

### Display Mode

You can choose how metrics are displayed:
- **Remaining**: Shows the percentage of quota left (default).
- **Used**: Shows the percentage of quota consumed.


## Join the Community

Follow us on social media for updates, discussions, and support:

- **Discord**: [Join our Discord server](https://discord.com/invite/PSeTkDMnr)
- **Matrix**: [Join the Matrix server](https://matrix.inled.es)
- **Mastodon**: [@inled on mastodon.social](https://mastodon.social/@inled)
- **YouTube**: [Inled Group YouTube Channel](https://www.youtube.com/@inledgroup)
- **X (Twitter)**: [@inledgroup on X](https://x.com/inledgroup)

## License

This project is licensed under the terms of the MIT license. Contributions are welcome! 

> [!WARNING]
> If you base your code on ours or remix it using AI, you must credit the original repository out of respect for the contributors and the creator.

## About:  
I've been working on a lot of projects lately and wasn't sure if people really cared about them until this one completely brought back my excitement for development and showed me how useful it can be for users. The GNOME community is fantastic.

> [!INFO]
> **AI DISCLAIMER**
> AI has been used on this project. ALL THE CODE has been reviewed.