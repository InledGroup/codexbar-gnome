#!/bin/bash
# Script to package the extension

UUID="codexbar@inled.es"

echo "Compiling schemas..."
glib-compile-schemas schemas/

echo "Packaging Codexbar"
gnome-extensions pack \
    --extra-source=extension.js \
    --extra-source=prefs.js \
    --extra-source=usageApi.js \
    --extra-source=secret.js \
    --extra-source=stylesheet.css \
    --extra-source=core/ \
    --extra-source=adapters/ \
    --extra-source=media/ \
    --schema=schemas/org.gnome.shell.extensions.codexbar.gschema.xml \
    --force

echo "Extension packed on ${UUID}.shell-extension.zip"
