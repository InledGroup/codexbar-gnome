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
> [!NOTE]
> Now added support for Antigravity CLI, the replacement of Gemini CLI for individual customers

## Requirements

The extension requires the CodexBar CLI tool installed on your system.

### Install CodexBar CLI

It is recommended to install the CLI via Homebrew:

```bash
brew install steipete/tap/codexbar
```

Ensure you have configured your providers and API keys in the CLI before using the extension.

## Installation

### Manual Installation

1. Clone this repository or download the source code.
2. Run the provided installation script:
   ```bash
   ./install.sh
   ```
3. Restart GNOME Shell:
   - On X11: Press `Alt+F2`, type `r`, and press `Enter`.
   - On Wayland: Log out and log back in.
4. Enable the extension using GNOME Extensions or via command line:
   ```bash
   gnome-extensions enable codexbar@inled.es
   ```

## Configuration

Access the settings through the gear icon in the extension menu.

### Provider Commands

Each provider must be configured with a command that returns JSON output.
Example for Gemini:
```bash
codexbar --provider gemini --source api --format json
```

The extension will automatically attempt to locate the `codexbar` binary in common locations such as `/home/linuxbrew/.linuxbrew/bin/` if an absolute path is not provided.

### Display Mode

You can choose how metrics are displayed:
- **Remaining**: Shows the percentage of quota left (default).
- **Used**: Shows the percentage of quota consumed.

## Documentation

Detailed setup guides and troubleshooting information can be found at [help.inled.es/codexbar-gnome](https://help.inled.es/codexbar-gnome).

## License

This project is licensed under the terms of the MIT license. Contributions are welcome!
