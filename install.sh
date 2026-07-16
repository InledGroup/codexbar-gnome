#!/bin/bash
# Script to install/reinstall the extension for quick tests

UUID="codexbar@inled.es"
ZIP_FILE="${UUID}.shell-extension.zip"

# 1. Make sure it is packed
./build.sh

echo "Deleting previous version (if it exists)..."
gnome-extensions uninstall "$UUID" 2>/dev/null
rm -rf ~/.local/share/gnome-shell/extensions/"$UUID"

echo "Installing new version"
gnome-extensions install "$ZIP_FILE" --force

echo "Enabling the extensions..."
gnome-extensions enable "$UUID"

echo "Installation finished. Read the README to know how to run the extension whether you are on wayland or x11."
